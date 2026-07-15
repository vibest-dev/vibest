import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Ref, Scope } from "effect";
import type * as Cause from "effect/Cause";

import type { SessionEvent } from "../../src/event-manifest";
import type {
  HarnessAgentAdapter,
  HarnessAgentSession,
  UserInput,
} from "../../src/runtime/adapter";
import { AgentOperationError } from "../../src/runtime/errors";
import { streamFromQueueOne } from "../../src/runtime/queue-stream";
import { makeHarnessAgentRegistry } from "../../src/runtime/registry";
import { makeHarnessAgentSessionService } from "../../src/runtime/session-service";
import type {
  ClaudeCodeUIMessageChunk,
  SessionEnvelope,
  SessionEnvelopeDraft,
} from "../../src/types/envelope";

const makeFixture = Effect.gen(function* () {
  const resumeGate = yield* Deferred.make<void>();
  const resumeCalls = yield* Ref.make(0);
  const closeCalls = yield* Ref.make(0);
  const holdClose = yield* Ref.make(false);
  const closeGate = yield* Deferred.make<void>();
  const crashGate = yield* Deferred.make<void>();
  const sequence = yield* Ref.make(0);
  const published = yield* Ref.make<ReadonlyArray<SessionEnvelope>>([]);

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
            return { turnId: "turn-1", cursor: 0, started: true };
          }),
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
    open: () => makeSession("created-session"),
    resume: ({ sessionId }) =>
      Ref.update(resumeCalls, (current) => current + 1).pipe(
        Effect.andThen(Deferred.await(resumeGate)),
        Effect.andThen(makeSession(sessionId)),
      ),
  } satisfies HarnessAgentAdapter;

  const service = yield* makeHarnessAgentSessionService(makeHarnessAgentRegistry([adapter]), {
    publish: (draft) =>
      Ref.modify(sequence, (current) => [current + 1, current + 1] as const).pipe(
        Effect.tap((seq) =>
          Ref.update(published, (current) => [...current, { ...draft, seq } as SessionEnvelope]),
        ),
      ),
  });

  return {
    service,
    resumeGate,
    resumeCalls,
    closeCalls,
    holdClose,
    closeGate,
    crashGate,
    published,
  };
});

it.effect("owns the event pump and projects a reconnect snapshot", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { workspacePath: "/tmp" });
    const receipt = yield* fixture.service.prompt(created.sessionId, {
      parts: [{ type: "text", text: "hello" }],
    });
    const snapshot = yield* Effect.eventually(
      fixture.service.getSnapshot(created.sessionId).pipe(
        Effect.filterOrFail(
          (current) => current.cursor === 3,
          () => new Error("event pump has not drained"),
        ),
      ),
    );

    NodeAssert.deepStrictEqual(receipt, { turnId: "turn-1", cursor: 0, started: true });
    NodeAssert.equal(snapshot.activeTurn?.chunks[0]?.body.type, "start");
    NodeAssert.deepStrictEqual(
      Array.from(yield* Ref.get(fixture.published), (event) => event.body.type),
      ["session.turn.started", "start", "session.turn.ended"],
    );

    yield* fixture.service.close(created.sessionId);
    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1);
    const missing = yield* fixture.service.getStatus(created.sessionId).pipe(Effect.flip);
    NodeAssert.equal(missing._tag, "SessionNotFound");
  }),
);

it.effect("tears down a session after its event stream reports a crash", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { workspacePath: "/tmp" });

    yield* Deferred.succeed(fixture.crashGate, undefined);
    yield* Effect.eventually(
      Ref.get(fixture.published).pipe(
        Effect.filterOrFail(
          (events) => events.some((event) => event.body.type === "session.crashed"),
          () => new Error("crash event was not published"),
        ),
      ),
    );

    yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });
    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1, "crashed session scope was not closed");
    const missing = yield* fixture.service.getStatus(created.sessionId).pipe(Effect.flip);
    NodeAssert.equal(missing._tag, "SessionNotFound");
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
    NodeAssert.equal((yield* fixture.service.getStatus(input.sessionId)).status, "running");
    yield* fixture.service.close(input.sessionId);
  }),
);

it.effect("waits for an in-flight close before resuming the same session id", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { workspacePath: "/tmp" });
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

    NodeAssert.equal((yield* fixture.service.getStatus(created.sessionId)).status, "running");
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
    NodeAssert.equal(
      (yield* fixture.service.getStatus(input.sessionId).pipe(Effect.flip))._tag,
      "SessionNotFound",
    );
  }),
);

it.effect("shares one idempotent close operation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const created = yield* fixture.service.create("claude-code", { workspacePath: "/tmp" });
    const first = yield* Effect.forkChild(fixture.service.close(created.sessionId));
    const second = yield* Effect.forkChild(fixture.service.close(created.sessionId));

    yield* Fiber.join(first);
    yield* Fiber.join(second);
    NodeAssert.equal(yield* Ref.get(fixture.closeCalls), 1);
  }),
);
