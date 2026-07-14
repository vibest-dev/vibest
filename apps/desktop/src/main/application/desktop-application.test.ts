import { Effect, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import type { BackendStatusSnapshot } from "../../shared/desktop-rpc";
import type { LocalBackend } from "../backend/local-backend";
import { makeDesktopApplication } from "./desktop-application";

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
    os: "darwin",
    quit: Effect.sync(() => {
      quits += 1;
    }),
  });

  return {
    application,
    setStatus: (snapshot: BackendStatusSnapshot) =>
      Effect.runPromise(SubscriptionRef.set(statusRef, snapshot)),
    retries: () => retries,
    quits: () => quits,
  };
}

describe("DesktopApplication", () => {
  it("exposes the renderer bootstrap without transport dependencies", async () => {
    const h = makeHarness();

    await expect(Effect.runPromise(h.application.bootstrap)).resolves.toEqual({
      os: "darwin",
      backend: {
        httpBaseUrl: "http://127.0.0.1:43123",
        wsBaseUrl: "ws://127.0.0.1:43123",
        token: "desktop-token",
      },
      status: "ready",
      statusRevision: 0,
    });

    await Effect.runPromise(h.application.retryBackend);
    await Effect.runPromise(h.application.quit);
    expect(h.retries()).toBe(1);
    expect(h.quits()).toBe(1);
  });

  it("waits for a backend revision newer than the caller has seen", async () => {
    const h = makeHarness();
    const pending = Effect.runPromise(h.application.waitForBackendStatus(0));

    await h.setStatus({ revision: 1, status: "reconnecting" });

    await expect(pending).resolves.toEqual({ revision: 1, status: "reconnecting" });
  });
});
