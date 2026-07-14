import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { Effect, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_RPC_PREFIX,
  type BackendStatus,
  type BackendStatusSnapshot,
  type DesktopContract,
} from "../../shared/desktop-rpc";
import { makeDesktopApplication } from "../application/desktop-application";
import type { LocalBackend } from "../backend/local-backend";
import { makeDesktopRpcHandler } from "./desktop-rpc";

type DesktopClient = RouterContractClient<DesktopContract>;

function makeHarness() {
  const statusRef = Effect.runSync(
    SubscriptionRef.make<BackendStatusSnapshot>({ revision: 0, status: "ready" }),
  );
  let retries = 0;
  let quits = 0;

  const backend: LocalBackend = {
    connection: {
      httpBaseUrl: "http://127.0.0.1:43123",
      wsBaseUrl: "ws://127.0.0.1:43123",
      token: "desktop-token",
    },
    snapshot: SubscriptionRef.get(statusRef),
    changes: SubscriptionRef.changes(statusRef),
    retry: Effect.sync(() => {
      retries += 1;
    }),
  };
  const application = makeDesktopApplication({
    backend,
    os: process.platform,
    quit: Effect.sync(() => {
      quits += 1;
    }),
  });
  const rpc = makeDesktopRpcHandler(application, ["http://desktop.test"]);
  const link = new RPCLink({
    origin: "http://desktop.test",
    url: DESKTOP_RPC_PREFIX,
    fetch: async (url, init) =>
      (await rpc(new Request(url, init))) ?? new Response("Not found", { status: 404 }),
  });
  const client: DesktopClient = createORPCClient(link);

  return {
    client,
    rpc,
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
  });

  it("holds a status poll until a later transition", async () => {
    const h = makeHarness();

    const pending = h.client.status.watch({ after: 0 });
    await h.setStatus("reconnecting");
    await expect(pending).resolves.toEqual({ revision: 1, status: "reconnecting" });
  });

  it("returns immediately when the client revision is behind", async () => {
    const h = makeHarness();

    await h.setStatus("reconnecting");
    await expect(h.client.status.watch({ after: 0 })).resolves.toEqual({
      revision: 1,
      status: "reconnecting",
    });
  });

  it("delegates retry and quit", async () => {
    const h = makeHarness();

    await h.client.backend.retry();
    await h.client.app.quit();
    expect(h.retries()).toBe(1);
    expect(h.quits()).toBe(1);
  });

  it("allows only the configured development origin", async () => {
    const h = makeHarness();
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

    expect(allowed?.headers.get("access-control-allow-origin")).toBe("http://desktop.test");
    expect(denied?.headers.get("access-control-allow-origin")).toBeNull();
  });
});
