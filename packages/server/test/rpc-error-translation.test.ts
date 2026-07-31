import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { SessionNotFound, SessionRefMismatch, StoreReadError } from "../src/errors";
import { AgentOperationError, HarnessSessionNotFound, SessionClosed } from "../src/harness";
import {
  activeSessionTranslation,
  sessionRefTranslation,
  translateErrors,
} from "../src/rpc/error-translation";

// A stand-in for oRPC's per-procedure `errors` bag: factories returning plain
// code+message records the assertions can compare structurally.
const errors = {
  NOT_FOUND: (input: { readonly message: string }) => ({ code: "NOT_FOUND", ...input }),
  INVALID_ARGUMENT: (input: { readonly message: string }) => ({
    code: "INVALID_ARGUMENT",
    ...input,
  }),
  SESSION_NOT_ACTIVE: (input: { readonly message: string }) => ({
    code: "SESSION_NOT_ACTIVE",
    ...input,
  }),
  INTERNAL: (input: { readonly message: string }) => ({ code: "INTERNAL", ...input }),
};

type AddressingError = SessionNotFound | SessionRefMismatch | StoreReadError;

describe("translateErrors", () => {
  it.effect("translates a mapped tag onto its declared protocol failure", () =>
    Effect.gen(function* () {
      const program: Effect.Effect<never, AddressingError> = Effect.fail(
        new SessionNotFound({ projectId: "p1", sessionId: "s1" }),
      );
      const failure = yield* translateErrors(program, sessionRefTranslation(errors)).pipe(
        Effect.flip,
      );
      assert.deepEqual(failure, { code: "NOT_FOUND", message: "session s1 not found" });
    }),
  );

  it.effect("keeps an 'internal' tag failing with the original error", () =>
    Effect.gen(function* () {
      const program: Effect.Effect<never, AddressingError> = Effect.fail(
        new StoreReadError({ file: "sessions.json", cause: "boom" }),
      );
      const failure = yield* translateErrors(program, sessionRefTranslation(errors)).pipe(
        Effect.flip,
      );
      assert.ok(failure instanceof StoreReadError);
    }),
  );

  it.effect("passes successes through untouched", () =>
    Effect.gen(function* () {
      const program: Effect.Effect<string, AddressingError> = Effect.succeed("ok");
      const value = yield* translateErrors(program, sessionRefTranslation(errors));
      assert.equal(value, "ok");
    }),
  );

  it.effect("maps the shared active-session group, INTERNAL keeping the message", () =>
    Effect.gen(function* () {
      type ActiveError = HarnessSessionNotFound | SessionClosed | AgentOperationError;
      const closed = yield* translateErrors(
        Effect.fail(new SessionClosed({ sessionId: "s1" })) as Effect.Effect<never, ActiveError>,
        activeSessionTranslation(errors),
      ).pipe(Effect.flip);
      assert.deepEqual(closed, { code: "SESSION_NOT_ACTIVE", message: "session s1 is closed" });

      const operation = new AgentOperationError({
        sessionId: "s1",
        operation: "prompt",
        cause: "exploded",
      });
      const internal = yield* translateErrors(
        Effect.fail(operation) as Effect.Effect<never, ActiveError>,
        activeSessionTranslation(errors),
      ).pipe(Effect.flip);
      assert.deepEqual(internal, { code: "INTERNAL", message: operation.message });
    }),
  );

  it("forces a decision for every tag at compile time", () => {
    const program: Effect.Effect<void, SessionNotFound | StoreReadError> = Effect.void;
    // A tag without a decision fails typecheck until it is mapped or
    // explicitly classified as internal.
    // @ts-expect-error — StoreReadError has no decision yet
    const incomplete = translateErrors(program, {
      SessionNotFound: () => Effect.fail(errors.NOT_FOUND({ message: "session gone" })),
    });
    // A decision for a tag the error channel no longer carries is flagged as
    // stale instead of silently ignored.
    const stale = translateErrors(program, {
      SessionNotFound: () => Effect.fail(errors.NOT_FOUND({ message: "session gone" })),
      StoreReadError: "internal",
      // @ts-expect-error — SessionClosed is not in this operation's error channel
      SessionClosed: "internal",
    });
    assert.ok(Effect.isEffect(incomplete) && Effect.isEffect(stale));
  });
});
