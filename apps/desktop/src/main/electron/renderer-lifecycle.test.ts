import { Context, Effect, Logger } from "effect";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { makeRendererLifecycle } from "./renderer-lifecycle";

type Gate = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<void>;
};

function makeGate(): Gate {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

// Each fake peer's detach promise is gated so tests control exactly when the
// previous peer finishes cleaning up.
function makeHarness() {
  const events: string[] = [];
  const gates: Gate[] = [];
  let nextPeer = 0;

  const connect = () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        nextPeer += 1;
        const id = nextPeer;
        const gate = makeGate();
        gates.push(gate);
        events.push(`attach:${id}`);
        return { id, gate };
      }),
      (peer) =>
        Effect.promise(() => peer.gate.promise).pipe(
          Effect.ensuring(Effect.sync(() => events.push(`detach:${peer.id}`))),
        ),
    ).pipe(Effect.asVoid);

  return {
    events,
    gates,
    connect,
    lifecycle: Effect.runSync(makeRendererLifecycle(connect)),
    webContents: {} as WebContents,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeRecordingLogger() {
  const logged: unknown[] = [];
  const context = Context.empty().pipe(
    Context.add(
      Logger.CurrentLoggers,
      new Set([
        Logger.make(({ message }) => {
          logged.push(...(Array.isArray(message) ? message : [message]));
        }),
      ]),
    ),
  ) as Context.Context<never>;
  return { logged, context };
}

describe("makeRendererLifecycle", () => {
  it("attaches the replacement only after the previous peer's detach resolves", async () => {
    const h = makeHarness();
    await Effect.runPromise(h.lifecycle.replace(h.webContents));
    expect(h.events).toEqual(["attach:1"]);

    const second = Effect.runPromise(h.lifecycle.replace(h.webContents));
    await settle();
    expect(h.events).toEqual(["attach:1"]);

    h.gates[0]?.resolve();
    await second;
    expect(h.events).toEqual(["attach:1", "detach:1", "attach:2"]);
  });

  it("does not complete shutdown before the active peer's cleanup resolves", async () => {
    const h = makeHarness();
    await Effect.runPromise(h.lifecycle.replace(h.webContents));

    let shutdownDone = false;
    const shutdown = Effect.runPromise(h.lifecycle.shutdown).then(() => {
      shutdownDone = true;
    });
    await settle();
    expect(shutdownDone).toBe(false);

    h.gates[0]?.resolve();
    await shutdown;
    expect(h.events).toEqual(["attach:1", "detach:1"]);
  });

  it("refuses attachments after shutdown", async () => {
    const h = makeHarness();
    await Effect.runPromise(h.lifecycle.shutdown);
    await Effect.runPromise(h.lifecycle.replace(h.webContents));
    expect(h.events).toEqual([]);
  });

  it("cleans up exactly once when close and shutdown race", async () => {
    const h = makeHarness();
    await Effect.runPromise(h.lifecycle.replace(h.webContents));

    const racing = Promise.all([
      Effect.runPromise(h.lifecycle.detach),
      Effect.runPromise(h.lifecycle.shutdown),
      Effect.runPromise(h.lifecycle.detach),
    ]);
    await settle();
    h.gates[0]?.resolve();
    await racing;
    expect(h.events).toEqual(["attach:1", "detach:1"]);
  });

  it("logs a failed detach instead of leaking the rejection", async () => {
    const h = makeHarness();
    const { logged, context } = makeRecordingLogger();
    await Effect.runPromise(h.lifecycle.replace(h.webContents));

    const shutdown = Effect.runPromise(h.lifecycle.shutdown.pipe(Effect.provideContext(context)));
    h.gates[0]?.reject(new Error("detach exploded"));
    await shutdown;

    expect(h.events).toEqual(["attach:1", "detach:1"]);
    expect(logged).toContain("Failed to detach the renderer RPC peer");
  });

  it("releases the acquired peer and logs when connecting fails after acquisition", async () => {
    const h = makeHarness();
    const { logged, context } = makeRecordingLogger();
    const lifecycle = Effect.runSync(
      makeRendererLifecycle(() =>
        h.connect().pipe(Effect.andThen(Effect.fail(new Error("handoff failed")))),
      ),
    );

    const replace = Effect.runPromise(
      lifecycle.replace(h.webContents).pipe(Effect.provideContext(context)),
    );
    await settle();
    h.gates[0]?.resolve();
    await replace;

    expect(h.events).toEqual(["attach:1", "detach:1"]);
    expect(logged).toContain("Failed to connect the renderer RPC peer");
  });
});
