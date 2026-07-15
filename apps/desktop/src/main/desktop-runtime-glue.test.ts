import { Effect, Layer, ManagedRuntime, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import type { BackendStatusSnapshot } from "../shared/desktop-rpc";
import { DesktopApplication } from "./application/desktop-application";
import { LocalBackend } from "./backend/local-backend";
import { DesktopApplicationLive } from "./desktop-runtime-glue";

describe("DesktopApplicationLive", () => {
  it("resolves a DesktopApplication built from a LocalBackend provided through the Layer graph", async () => {
    const statusRef = Effect.runSync(
      SubscriptionRef.make<BackendStatusSnapshot>({ revision: 0, status: "ready" }),
    );

    // Only LocalBackend is faked: this test exercises the Layer wiring
    // introduced by this module (LocalBackend -> DesktopApplication), not
    // the already-covered supervision logic inside makeLocalBackend itself.
    const fakeLocalBackendLive = Layer.succeed(LocalBackend, {
      connection: {
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        token: "fake-token",
      },
      snapshot: SubscriptionRef.get(statusRef),
      changes: SubscriptionRef.changes(statusRef),
      retry: Effect.void,
    });

    const runtime = ManagedRuntime.make(
      DesktopApplicationLive.pipe(Layer.provide(fakeLocalBackendLive)),
    );

    try {
      const bootstrap = await runtime.runPromise(
        Effect.gen(function* () {
          const application = yield* DesktopApplication;
          return yield* application.bootstrap;
        }),
      );

      expect(bootstrap).toMatchObject({
        os: process.platform,
        backend: { token: "fake-token" },
        status: "ready",
        statusRevision: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });
});
