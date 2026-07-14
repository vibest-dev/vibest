import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { Context, Effect, Layer, ManagedRuntime, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_RPC_PREFIX,
  type BackendStatus,
  type BackendStatusSnapshot,
  type DesktopContract,
} from "../shared/desktop-rpc";
import { DesktopLifecycle } from "./desktop-lifecycle";
import { createDesktopRpcHandler, type DesktopRpcServices } from "./desktop-rpc";
import { BackendSupervisor } from "./supervisor";

type DesktopClient = RouterContractClient<DesktopContract>;

function makeHarness() {
  const statusRef = Effect.runSync(
    SubscriptionRef.make<BackendStatusSnapshot>({ revision: 0, status: "ready" }),
  );
  let retries = 0;
  let quits = 0;

  const layer = Layer.merge(
    Layer.succeed(
      BackendSupervisor,
      BackendSupervisor.of({
        connection: {
          httpBaseUrl: "http://127.0.0.1:43123",
          wsBaseUrl: "ws://127.0.0.1:43123",
          token: "desktop-token",
        },
        snapshot: SubscriptionRef.get(statusRef),
        status: SubscriptionRef.get(statusRef).pipe(Effect.map((current) => current.status)),
        changes: SubscriptionRef.changes(statusRef),
        retry: Effect.sync(() => {
          retries += 1;
        }),
      }),
    ),
    Layer.succeed(
      DesktopLifecycle,
      DesktopLifecycle.of({
        requestQuit: Effect.sync(() => {
          quits += 1;
        }),
      }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const effectContext = runtime.runSync(
    runtime.contextEffect,
  ) as Context.Context<DesktopRpcServices>;
  const rpc = createDesktopRpcHandler(effectContext, ["http://desktop.test"]);
  const link = new RPCLink({
    origin: "http://desktop.test",
    url: DESKTOP_RPC_PREFIX,
    fetch: async (url, init) => {
      const result = await rpc(new Request(url, init));
      return result.matched ? result.response : new Response("Not found", { status: 404 });
    },
  });
  const client: DesktopClient = createORPCClient(link);

  return {
    client,
    rpc,
    runtime,
    setStatus: (status: BackendStatus) =>
      Effect.runPromise(
        SubscriptionRef.update(statusRef, (current) => ({
          revision: current.revision + 1,
          status,
        })),
      ),
    retries: () => retries,
    quits: () => quits,
  };
}

describe("Desktop RPC", () => {
  it("bootstraps through the real oRPC Fetch codecs", async () => {
    const h = makeHarness();
    try {
      await expect(h.client.bootstrap()).resolves.toEqual({
        os: process.platform,
        backend: {
          httpBaseUrl: "http://127.0.0.1:43123",
          wsBaseUrl: "ws://127.0.0.1:43123",
          token: "desktop-token",
        },
        status: "ready",
        statusRevision: 0,
      });
    } finally {
      await h.runtime.dispose();
    }
  });

  it("holds a status poll until a later transition", async () => {
    const h = makeHarness();
    try {
      const pending = h.client.status.watch({ after: 0 });
      await h.setStatus("reconnecting");
      await expect(pending).resolves.toEqual({ revision: 1, status: "reconnecting" });
    } finally {
      await h.runtime.dispose();
    }
  });

  it("returns immediately when the client revision is behind", async () => {
    const h = makeHarness();
    try {
      await h.setStatus("reconnecting");
      await expect(h.client.status.watch({ after: 0 })).resolves.toEqual({
        revision: 1,
        status: "reconnecting",
      });
    } finally {
      await h.runtime.dispose();
    }
  });

  it("delegates retry and quit", async () => {
    const h = makeHarness();
    try {
      await h.client.backend.retry();
      await h.client.app.quit();
      expect(h.retries()).toBe(1);
      expect(h.quits()).toBe(1);
    } finally {
      await h.runtime.dispose();
    }
  });

  it("allows only the configured development origin", async () => {
    const h = makeHarness();
    try {
      const allowed = await h.rpc(
        new Request("http://desktop.test/api/desktop-rpc/bootstrap", {
          method: "OPTIONS",
          headers: {
            Origin: "http://desktop.test",
            "Access-Control-Request-Method": "POST",
          },
        }),
      );
      const denied = await h.rpc(
        new Request("http://desktop.test/api/desktop-rpc/bootstrap", {
          method: "OPTIONS",
          headers: {
            Origin: "https://attacker.example",
            "Access-Control-Request-Method": "POST",
          },
        }),
      );

      expect(allowed.matched && allowed.response.headers.get("access-control-allow-origin")).toBe(
        "http://desktop.test",
      );
      expect(
        denied.matched && denied.response.headers.get("access-control-allow-origin"),
      ).toBeNull();
    } finally {
      await h.runtime.dispose();
    }
  });
});
