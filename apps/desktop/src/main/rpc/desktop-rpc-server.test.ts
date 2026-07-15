import { MessageChannel } from "node:worker_threads";

import { consumeEventIterator, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterContractClient } from "@orpc/contract";
import { ORPCError } from "@orpc/server";
import { Context, Effect, Logger, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import type { BackendStatusSnapshot, DesktopContract } from "../../shared/desktop-rpc";
import {
  type DesktopApplication,
  makeDesktopApplication,
} from "../application/desktop-application";
import type { LocalBackend } from "../backend/local-backend";
import { makeDesktopRpcServer } from "./desktop-rpc-server";

type DesktopClient = RouterContractClient<DesktopContract>;

function makeHarness(
  override?: (application: DesktopApplication["Service"]) => DesktopApplication["Service"],
) {
  const statusRef = Effect.runSync(
    SubscriptionRef.make<BackendStatusSnapshot>({ revision: 0, status: "ready" }),
  );
  let retries = 0;
  let quits = 0;
  let streamFinalizers = 0;

  // A recording logger inside the injected context proves that handler
  // bodies and the error-logging wrapper both run against the composition
  // root's ServiceMap rather than the default one.
  const logged: unknown[] = [];
  const rpcContext = Context.empty().pipe(
    Context.add(
      Logger.CurrentLoggers,
      new Set([
        Logger.make(({ message }) => {
          logged.push(...(Array.isArray(message) ? message : [message]));
        }),
      ]),
    ),
  ) as Context.Context<never>;

  const backend: LocalBackend["Service"] = {
    connection: {
      httpBaseUrl: "http://127.0.0.1:43123",
      wsBaseUrl: "ws://127.0.0.1:43123",
      token: "desktop-token",
    },
    snapshot: SubscriptionRef.get(statusRef),
    changes: SubscriptionRef.changes(statusRef).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          streamFinalizers += 1;
        }),
      ),
    ),
    retry: Effect.sync(() => {
      retries += 1;
    }),
  };
  const base = makeDesktopApplication({
    backend,
    os: "darwin",
    quit: Effect.sync(() => {
      quits += 1;
    }),
  });
  const server = makeDesktopRpcServer(override ? override(base) : base, rpcContext);
  const { port1, port2 } = new MessageChannel();
  const detach = server.attach(port1);
  port1.start();
  port2.start();

  const client: DesktopClient = createORPCClient(new RPCLink({ port: port2 }));

  return {
    client,
    setStatus: (snapshot: BackendStatusSnapshot) =>
      Effect.runPromise(SubscriptionRef.set(statusRef, snapshot)),
    retries: () => retries,
    quits: () => quits,
    streamFinalizers: () => streamFinalizers,
    logged: () => logged,
    close: async () => {
      await detach();
      port1.close();
      port2.close();
    },
  };
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

describe("Desktop MessagePort RPC", () => {
  it("runs unary procedures through the native oRPC MessagePort codecs", async () => {
    const h = makeHarness();
    try {
      await expect(h.client.bootstrap()).resolves.toEqual({
        os: "darwin",
        backend: {
          httpBaseUrl: "http://127.0.0.1:43123",
          wsBaseUrl: "ws://127.0.0.1:43123",
          token: "desktop-token",
        },
        status: "ready",
        statusRevision: 0,
      });

      await h.client.backend.retry();
      await h.client.app.quit();
      expect(h.retries()).toBe(1);
      expect(h.quits()).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("streams status and runs the server finalizer when the client cancels", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const received: BackendStatusSnapshot[] = [];
    const unsubscribe = consumeEventIterator(
      h.client.status.subscribe({ after: 0 }, { signal: controller.signal }),
      {
        onEvent: (snapshot) => received.push(snapshot),
        onError: () => {},
        onFinish: () => {},
      },
    );

    try {
      await h.setStatus({ revision: 1, status: "reconnecting" });
      await eventually(() =>
        expect(received).toContainEqual({ revision: 1, status: "reconnecting" }),
      );

      controller.abort();
      await unsubscribe();
      await eventually(() => expect(h.streamFinalizers()).toBe(1));
      // Client cancellation is an interrupt-only cause and must stay silent.
      expect(h.logged()).not.toContain("desktop rpc failed");
    } finally {
      await h.close();
    }
  });

  it("runs handler bodies against the injected composition-root context", async () => {
    const h = makeHarness((application) => ({
      ...application,
      bootstrap: application.bootstrap.pipe(Effect.tap(() => Effect.log("bootstrap handled"))),
    }));
    try {
      await h.client.bootstrap();
      expect(h.logged()).toContain("bootstrap handled");
    } finally {
      await h.close();
    }
  });

  it("logs unexpected failures through the injected logger", async () => {
    const h = makeHarness((application) => ({
      ...application,
      quit: Effect.die(new Error("boom")),
    }));
    try {
      // Defects are sanitized before they reach the client.
      await expect(h.client.app.quit()).rejects.toThrow("Internal Server Error");
      expect(h.logged()).toContain("desktop rpc failed");
    } finally {
      await h.close();
    }
  });

  it("stays silent for expected ORPCErrors", async () => {
    const h = makeHarness((application) => ({
      ...application,
      // Simulates a handler failing with an expected oRPC error; the
      // application type does not model it, hence the cast.
      quit: Effect.fail(new ORPCError("NOT_FOUND")) as unknown as Effect.Effect<void>,
    }));
    try {
      await expect(h.client.app.quit()).rejects.toThrow("Not Found");
      expect(h.logged()).not.toContain("desktop rpc failed");
    } finally {
      await h.close();
    }
  });
});
