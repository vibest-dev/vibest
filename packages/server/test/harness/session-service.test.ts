import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { ClaudeCodeUIMessageChunk, SessionEnvelopeDraft, SessionEvent } from "@vibest/harness";
import { Deferred, Effect, Exit, Fiber, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import type {
  HarnessAgentAdapter,
  HarnessAgentSession,
  SessionInfoResult,
  UserInput,
} from "../../src/harness/adapter";
import { AgentOperationError } from "../../src/harness/errors";
import { streamFromQueueOne } from "../../src/harness/queue-stream";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";
import { makeHarnessAgentSessionService } from "../../src/harness/session-service";

const makeFixture = Effect.gen(function* () {
  const resumeGate = yield* Deferred.make<void>();
  const resumeCalls = yield* Ref.make(0);
  const closeCalls = yield* Ref.make(0);
  const holdClose = yield* Ref.make(false);
  const closeGate = yield* Deferred.make<void>();
  const crashGate = yield* Deferred.make<void>();

  const makeSession = (sessionId: string): Effect.Effect<HarnessAgentSession, never, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const events = yield* Queue.bounded<SessionEnvelopeDraft, Cause.Done | AgentOperationError>(
        32,
      );
      const closed = yield* Ref.make(false);
      const emit = (body: ClaudeCodeUIMessageChunk | SessionEvent) =>
        Queue.offer(events, { harnessAgentId: "claude-code", sessionId, body }).pipe(Effect.asVoid);
      const close = Ref.getAndSet(closed, true).pipe(
        Effect.flatMap((alreadyClosed) =>
          alreadyClosed
            ? Effect.void
            : Ref.update(closeCalls, (current) => current + 1).pipe(
                Effect.andThen(
                  Ref.get(holdClose).pipe(
                    Effect.flatMap((held) => (held ? Deferred.await(closeGate) : Effect.void)),
                  ),
                ),
                Effect.andThen(Queue.end(events)),
                Effect.asVoid,
              ),
        ),
      );
      yield* Scope.addFinalizer(scope, close);
      yield* Deferred.await(crashGate).pipe(
        Effect.andThen(
          emit({
            type: "session.crashed",
            sessionId,
            reason: "native process exited",
          }),
        ),
        Effect.andThen(Queue.end(events)),
        Effect.forkIn(scope),
      );

      return {
        sessionId,
        harnessAgentId: "claude-code",
        events: streamFromQueueOne(events),
        prompt: (_input: UserInput) =>
          Effect.gen(function* () {
            yield* emit({ type: "session.turn.started", sessionId, turnId: "turn-1" });
            yield* emit({ type: "start" });
            yield* emit({
              type: "session.turn.ended",
              sessionId,
              turnId: "turn-1",
              outcome: "completed",
            });
            return { turnId: "turn-1" };
          }),
        setModel: () => Effect.void,
        setReasoningEffort: () => Effect.void,
        setPermissionMode: () => Effect.void,
        interrupt: Effect.void,
        respondToAgentRequest: () => Effect.void,
        getCapabilities: Effect.succeed({
          supportsResume: true,
          supportsSteering: false,
          supportsPermissions: false,
        }),
        close,
      } satisfies HarnessAgentSession;
    });

  const adapter = {
    id: "claude-code",
    descriptor: { id: "claude-code", name: "Claude Code" },
    checkAvailability: Effect.succeed({ available: true }),
    permissionModes: [],
    open: () => makeSession("created-session"),
    resume: ({ sessionId }) =>
      Ref.update(resumeCalls, (current) => current + 1).pipe(
        Effect.andThen(Deferred.await(resumeGate)),
        Effect.andThen(makeSession(sessionId)),
      ),
    getSessionInfo: () => Effect.succeed<SessionInfoResult>({ _tag: "unsupported" }),
  } satisfies HarnessAgentAdapter;

  const service = yield* makeHarnessAgentSessionService(makeHarnessAgentRegistry([adapter]));

  return {
    service,
    resumeGate,
    resumeCalls,
    closeCalls,
    holdClose,
    closeGate,
    crashGate,
  };
});

/** Liveness probe: `events` succeeds while a session is active, fails once torn down. */
const isActive = (
  fixture: {
    readonly service: { readonly events: (id: string) => Effect.Effect<unknown, unknown> };
  },
  sessionId: string,
) => fixture.service.events(sessionId).pipe(Effect.exit, Effect.map(Exit.isSuccess));

it.effect("exposes the raw per-session event stream and tears down on close", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { cwd: "/tmp" });
    const stream = yield* fixture.service.events(created.sessionId);
    const collected = yield* Effect.forkChild(
      Stream.runCollect(stream.pipe(Stream.map((draft) => draft.body.type))),
    );

    const receipt = yield* fixture.service.prompt(created.sessionId, {
      parts: [{ type: "text", text: "hello" }],
    });
    // Ending the native queue (via close) completes the single-consumer stream.
    yield* fixture.service.close(created.sessionId);
    const events = yield* Fiber.join(collected);

    NodeAssert.deepStrictEqual(receipt, { turnId: "turn-1" });
    NodeAssert.deepStrictEqual(Array.from(events), [
      "session.turn.started",
      "start",
      "session.turn.ended",
    ]);
    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1);
    NodeAssert.equal(yield* isActive(fixture, created.sessionId), false);
  }),
);

it.effect("single-flights resume in owner scope when the first waiter cancels", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const first = yield* Effect.forkChild(fixture.service.resume(input));
    const second = yield* Effect.forkChild(fixture.service.resume(input));

    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("resume did not single-flight"),
        ),
      ),
    );
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(second);

    NodeAssert.equal(yield* Ref.get(fixture.resumeCalls), 1);
    NodeAssert.equal(yield* isActive(fixture, input.sessionId), true);
    yield* fixture.service.close(input.sessionId);
  }),
);

it.effect("waits for an in-flight close before resuming the same session id", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { cwd: "/tmp" });
    yield* Ref.set(fixture.holdClose, true);
    const close = yield* Effect.forkChild(fixture.service.close(created.sessionId));
    yield* Effect.eventually(
      Ref.get(fixture.closeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("close did not start"),
        ),
      ),
    );
    const resume = yield* Effect.forkChild(
      fixture.service.resume({
        sessionId: created.sessionId,
        harnessAgentId: "claude-code",
      }),
    );

    yield* Effect.yieldNow;
    NodeAssert.equal(yield* Ref.get(fixture.resumeCalls), 0);
    yield* Deferred.succeed(fixture.closeGate, undefined);
    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("resume did not start after close"),
        ),
      ),
    );
    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(close);
    yield* Fiber.join(resume);

    NodeAssert.equal(yield* isActive(fixture, created.sessionId), true);
    yield* fixture.service.close(created.sessionId);
  }),
);

it.effect("closes a session that is still being resumed", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const resume = yield* Effect.forkChild(fixture.service.resume(input));
    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("resume did not start"),
        ),
      ),
    );
    const close = yield* Effect.forkChild(fixture.service.close(input.sessionId));

    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(resume);
    yield* Fiber.join(close);

    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1);
    NodeAssert.equal(yield* isActive(fixture, input.sessionId), false);
  }),
);

it.effect("shares one idempotent close operation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { cwd: "/tmp" });
    const first = yield* Effect.forkChild(fixture.service.close(created.sessionId));
    const second = yield* Effect.forkChild(fixture.service.close(created.sessionId));

    yield* Fiber.join(first);
    yield* Fiber.join(second);
    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1);
  }),
);
