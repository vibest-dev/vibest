import { Effect, Option, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "vitest";

import type { ServerConnection, ServerStatusSnapshot } from "../../shared/desktop-rpc";
import type { LocalServer } from "../server/local-server";
import { makeDesktopApplication } from "./desktop-application";

// Whichever host the suite runs on — asserting a literal would pin these tests
// to the developer's OS and fail on a different CI runner.
const anyOs = expect.stringMatching(/^(macos|windows|linux)$/);

function makeHarness(
  connection: Effect.Effect<ServerConnection> = Effect.succeed({
    httpBaseUrl: "http://127.0.0.1:43123",
    wsBaseUrl: "ws://127.0.0.1:43123",
    token: "desktop-token",
  }),
) {
  const statusRef = Effect.runSync(
    SubscriptionRef.make<ServerStatusSnapshot>({ revision: 0, status: "ready" }),
  );
  let retries = 0;
  let quits = 0;
  const server: LocalServer["Service"] = {
    connection,
    snapshot: SubscriptionRef.get(statusRef),
    changes: SubscriptionRef.changes(statusRef),
    retry: Effect.sync(() => {
      retries += 1;
    }),
  };
  const application = makeDesktopApplication({
    server,
    quit: Effect.sync(() => {
      quits += 1;
    }),
  });

  return {
    application,
    setStatus: (snapshot: ServerStatusSnapshot) =>
      Effect.runPromise(SubscriptionRef.set(statusRef, snapshot)),
    retries: () => retries,
    quits: () => quits,
  };
}

describe("DesktopApplication", () => {
  it("exposes the renderer bootstrap without transport dependencies", async () => {
    const h = makeHarness();

    await expect(Effect.runPromise(h.application.bootstrap)).resolves.toEqual({
      status: "ready",
      statusRevision: 0,
      os: anyOs,
    });
    await expect(Effect.runPromise(h.application.serverConnection)).resolves.toEqual({
      httpBaseUrl: "http://127.0.0.1:43123",
      wsBaseUrl: "ws://127.0.0.1:43123",
      token: "desktop-token",
    });

    await Effect.runPromise(h.application.retryServer);
    await Effect.runPromise(h.application.quit);
    expect(h.retries()).toBe(1);
    expect(h.quits()).toBe(1);
  });

  it("bootstraps shell state without waiting for the server connection", async () => {
    const h = makeHarness(Effect.never);

    await expect(Effect.runPromise(h.application.bootstrap)).resolves.toEqual({
      status: "ready",
      statusRevision: 0,
      os: anyOs,
    });
  });

  it("streams server revisions newer than the caller has seen", async () => {
    const h = makeHarness();
    const pending = Effect.runPromise(h.application.watchServerStatus(0).pipe(Stream.runHead));

    await h.setStatus({ revision: 1, status: "reconnecting" });

    await expect(pending.then(Option.getOrUndefined)).resolves.toEqual({
      revision: 1,
      status: "reconnecting",
    });
  });

  it("replays the current snapshot when subscribing after a change", async () => {
    const h = makeHarness();
    await h.setStatus({ revision: 1, status: "reconnecting" });

    const head = await Effect.runPromise(h.application.watchServerStatus(0).pipe(Stream.runHead));

    expect(Option.getOrUndefined(head)).toEqual({ revision: 1, status: "reconnecting" });
  });

  it("does not replay revisions the caller has already seen", async () => {
    const h = makeHarness();
    await h.setStatus({ revision: 1, status: "reconnecting" });

    const pending = Effect.runPromise(h.application.watchServerStatus(1).pipe(Stream.runHead));
    await h.setStatus({ revision: 2, status: "ready" });

    await expect(pending.then(Option.getOrUndefined)).resolves.toEqual({
      revision: 2,
      status: "ready",
    });
  });
});
