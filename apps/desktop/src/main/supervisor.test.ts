import { Deferred, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { type BackendProcessConfig, BackendProcess, type RunningBackendProcess } from "./backend";
import { BackendExitedBeforeReady } from "./errors";
import { LoginShellPath } from "./shell-path";
import {
  BackendSupervisor,
  type BackendSupervisorOptions,
  makeBackendSupervisorLayer,
  restartBackoff,
} from "./supervisor";

type FakeProcess = {
  readonly port: number;
  readonly config: BackendProcessConfig;
  readonly becomeReady: (port?: number) => void;
  readonly failBeforeReady: () => void;
  readonly exit: () => void;
  killed: boolean;
};

function makeHarness(overrides: Partial<BackendSupervisorOptions> = {}) {
  const processes: FakeProcess[] = [];

  const processLayer = Layer.succeed(
    BackendProcess,
    BackendProcess.of({
      launch: (config, port): Effect.Effect<RunningBackendProcess, never, Scope.Scope> =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<number, BackendExitedBeforeReady>();
          const exited = yield* Deferred.make<{ exitCode: number | null }>();
          const process: FakeProcess = {
            port,
            config,
            killed: false,
            becomeReady: (boundPort = port || 40_000) => {
              Effect.runSync(Deferred.succeed(ready, boundPort));
            },
            failBeforeReady: () => {
              Effect.runSync(
                Deferred.fail(
                  ready,
                  new BackendExitedBeforeReady({
                    exitCode: 1,
                    message: "exited before ready",
                  }),
                ),
              );
            },
            exit: () => {
              Effect.runSync(Deferred.succeed(exited, { exitCode: 1 }));
            },
          };
          processes.push(process);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.killed = true;
            }),
          );
          return {
            ready: Deferred.await(ready),
            awaitExit: Deferred.await(exited),
          };
        }),
    }),
  );

  const shellLayer = Layer.succeed(
    LoginShellPath,
    LoginShellPath.of({ get: Effect.succeed("/login/bin:/usr/bin") }),
  );

  const options: BackendSupervisorOptions = {
    entry: "/fake/cli.mjs",
    token: "fixed-token",
    corsOrigins: ["vibest://app"],
    useLoginShellPath: true,
    initialRestartDelayMs: 0,
    maxRestartDelayMs: 0,
    maxFastFailures: 5,
    stableAfterMs: 10_000,
    ...overrides,
  };

  const dependencies = Layer.merge(processLayer, shellLayer);
  const layer = makeBackendSupervisorLayer(options).pipe(Layer.provide(dependencies));
  const runtime = ManagedRuntime.make(layer);

  return { processes, runtime };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("BackendSupervisor", () => {
  it("starts on port 0 and exposes the fixed connection after ready", async () => {
    const h = makeHarness();
    const supervisorPromise = h.runtime.runPromise(BackendSupervisor);

    await eventually(() => expect(h.processes[0]?.port).toBe(0));
    h.processes[0]!.becomeReady(56_789);
    const supervisor = await supervisorPromise;

    expect(supervisor.connection).toEqual({
      httpBaseUrl: "http://127.0.0.1:56789",
      wsBaseUrl: "ws://127.0.0.1:56789",
      token: "fixed-token",
    });
    await expect(h.runtime.runPromise(supervisor.status)).resolves.toBe("ready");
    expect(h.processes[0]!.config.shellPath).toBe("/login/bin:/usr/bin");

    await h.runtime.dispose();
  });

  it("fails the layer when the first process never becomes ready", async () => {
    const h = makeHarness();
    const supervisorPromise = h.runtime.runPromise(BackendSupervisor);

    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.failBeforeReady();

    await expect(supervisorPromise).rejects.toThrow("exited before ready");
    expect(h.processes).toHaveLength(1);
    await h.runtime.dispose();
  });

  it("restarts on the same pinned port and keeps the token", async () => {
    const h = makeHarness();
    const supervisorPromise = h.runtime.runPromise(BackendSupervisor);
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    const supervisor = await supervisorPromise;

    h.processes[0]!.exit();
    await eventually(() => expect(h.processes).toHaveLength(2));
    expect(h.processes[1]!.port).toBe(50_000);
    expect(h.processes[1]!.config.token).toBe("fixed-token");
    h.processes[1]!.becomeReady();
    await eventually(async () => {
      expect(await h.runtime.runPromise(supervisor.status)).toBe("ready");
    });

    await h.runtime.dispose();
  });

  it("enters failed after repeated crashes and retries only once", async () => {
    const h = makeHarness({ maxFastFailures: 2 });
    const supervisorPromise = h.runtime.runPromise(BackendSupervisor);
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    const supervisor = await supervisorPromise;

    h.processes[0]!.exit();
    await eventually(() => expect(h.processes).toHaveLength(2));
    h.processes[1]!.failBeforeReady();
    await eventually(() => expect(h.processes).toHaveLength(3));
    h.processes[2]!.failBeforeReady();
    await eventually(async () => {
      expect(await h.runtime.runPromise(supervisor.status)).toBe("failed");
    });

    await Promise.all([
      h.runtime.runPromise(supervisor.retry),
      h.runtime.runPromise(supervisor.retry),
      h.runtime.runPromise(supervisor.retry),
    ]);
    await eventually(() => expect(h.processes).toHaveLength(4));
    expect(h.processes[3]!.port).toBe(50_000);
    h.processes[3]!.becomeReady();
    await eventually(async () => {
      expect(await h.runtime.runPromise(supervisor.status)).toBe("ready");
    });

    await h.runtime.dispose();
  });

  it("kills the current process when the runtime is disposed", async () => {
    const h = makeHarness();
    const supervisorPromise = h.runtime.runPromise(BackendSupervisor);
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    await supervisorPromise;

    await h.runtime.dispose();

    expect(h.processes[0]!.killed).toBe(true);
  });
});

describe("restartBackoff", () => {
  it("doubles and caps", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => restartBackoff(n, 500, 10_000))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000,
    ]);
  });
});
