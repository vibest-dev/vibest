import { MessageChannel } from "node:worker_threads";

import { consumeEventIterator, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterContractClient } from "@orpc/contract";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import type { BackendStatusSnapshot, DesktopContract } from "../../shared/desktop-rpc";
import { makeDesktopApplication } from "../application/desktop-application";
import type { LocalBackend } from "../backend/local-backend";
import { makeDesktopRpcServer } from "./desktop-rpc-server";

type DesktopClient = RouterContractClient<DesktopContract>;

function makeHarness() {
  const statusRef = Effect.runSync(
    SubscriptionRef.make<BackendStatusSnapshot>({ revision: 0, status: "ready" }),
  );
  let retries = 0;
  let quits = 0;
  let streamFinalizers = 0;

  const backend: LocalBackend = {
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
  const application = makeDesktopApplication({
    backend,
    os: "darwin",
    quit: Effect.sync(() => {
      quits += 1;
    }),
  });
  const server = makeDesktopRpcServer(application);
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
    } finally {
      await h.close();
    }
  });
});
