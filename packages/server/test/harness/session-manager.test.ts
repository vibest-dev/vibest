import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import type { ClaudeCodeUIMessageChunk } from "@vibest/contract/claude-code";
import { Deferred, Effect, Exit, Fiber, Queue, Ref, Scope } from "effect";
import type * as Cause from "effect/Cause";

import { makeEventBus } from "../../src/events/event-bus";
import type {
  HarnessAgentAdapter,
  HarnessAgentSession,
  SessionInfoResult,
  UserInput,
} from "../../src/harness/adapter";
import { AgentOperationError } from "../../src/harness/errors";
import type { SessionEnvelopeDraft, SessionEvent } from "../../src/harness/events/framework";
import { streamFromQueueOne } from "../../src/harness/queue-stream";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";
import { makeHarnessAgentSessionManager } from "../../src/harness/session-manager";
import { NodePlatformLayer } from "../platform";

const refFor = (sessionId: string): SessionRef => ({
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: `server-${sessionId}`,
});

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
      // A crash is a *failing* native stream (a clean end is a normal
      // teardown): failing the queue is what trips the drain's crash path.
      yield* Deferred.await(crashGate).pipe(
        Effect.andThen(
          Queue.fail(
            events,
            new AgentOperationError({
              sessionId,
              operation: "events",
              cause: "native process exited",
            }),
          ),
        ),
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

  const registry = makeHarnessAgentRegistry([adapter]);
  const bus = yield* makeEventBus();
  const manager = yield* makeHarnessAgentSessionManager(registry, bus).pipe(
    Effect.provide(NodePlatformLayer),
  );

  return {
    manager,
    resumeGate,
    resumeCalls,
    closeCalls,
    holdClose,
    closeGate,
    crashGate,
  };
});

type Fixture = Effect.Success<typeof makeFixture>;

/** Liveness probe: `get` succeeds while a session is active, fails once torn down. */
const isActive = (fixture: Fixture, sessionId: string) =>
  fixture.manager.get(sessionId).pipe(Effect.exit, Effect.map(Exit.isSuccess));

it.effect("drains the native stream into the projection and tears down on close", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, ref);

    const receipt = yield* session.prompt({ parts: [{ type: "text", text: "hello" }] });
    // The manager's internal drain projects the emitted turn: 3 events, seq 3.
    const snapshot = yield* Effect.eventually(
      fixture.manager.snapshot(ref).pipe(
        Effect.filterOrFail(
          (current) => current.cursor >= 3,
          () => new Error("projection did not catch up"),
        ),
      ),
    );

    yield* fixture.manager.close(session.sessionId);

    assert.deepEqual(receipt, { turnId: "turn-1" });
    assert.equal(snapshot.status.phase, "idle");
    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
    assert.equal(yield* isActive(fixture, session.sessionId), false);
    // Close discards the projection with the instance.
    assert.equal(
      yield* fixture.manager.status(ref).pipe(Effect.exit, Effect.map(Exit.isSuccess)),
      false,
    );
  }),
);

it.effect("single-flights ensure in owner scope when the first waiter cancels", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const ref = refFor("resumed");
    const first = yield* Effect.forkChild(fixture.manager.ensure(input, ref));
    const second = yield* Effect.forkChild(fixture.manager.ensure(input, ref));

    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("ensure did not single-flight"),
        ),
      ),
    );
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(second);

    assert.equal(yield* Ref.get(fixture.resumeCalls), 1);
    assert.equal(yield* isActive(fixture, input.sessionId), true);
    yield* fixture.manager.close(input.sessionId);
  }),
);

it.effect("waits for an in-flight close before reopening the same session id", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, ref);
    yield* Ref.set(fixture.holdClose, true);
    const close = yield* Effect.forkChild(fixture.manager.close(session.sessionId));
    yield* Effect.eventually(
      Ref.get(fixture.closeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("close did not start"),
        ),
      ),
    );
    const resume = yield* Effect.forkChild(
      fixture.manager.ensure({ sessionId: session.sessionId, harnessAgentId: "claude-code" }, ref),
    );

    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(fixture.resumeCalls), 0);
    yield* Deferred.succeed(fixture.closeGate, undefined);
    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("ensure did not start after close"),
        ),
      ),
    );
    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(close);
    yield* Fiber.join(resume);

    assert.equal(yield* isActive(fixture, session.sessionId), true);
    yield* fixture.manager.close(session.sessionId);
  }),
);

it.effect("closes a session that is still being resumed", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const resume = yield* Effect.forkChild(fixture.manager.ensure(input, refFor("resumed")));
    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("ensure did not start"),
        ),
      ),
    );
    const close = yield* Effect.forkChild(fixture.manager.close(input.sessionId));

    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(resume);
    yield* Fiber.join(close);

    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
    assert.equal(yield* isActive(fixture, input.sessionId), false);
  }),
);

it.effect("shares one idempotent close operation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, refFor("created"));
    const first = yield* Effect.forkChild(fixture.manager.close(session.sessionId));
    const second = yield* Effect.forkChild(fixture.manager.close(session.sessionId));

    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
  }),
);

it.effect("a crash releases the instance but keeps the projection queryable", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, ref);

    yield* Deferred.succeed(fixture.crashGate, undefined);
    // The crash closes the native instance (onCrash) …
    yield* Effect.eventually(
      Ref.get(fixture.closeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("crash did not close the instance"),
        ),
      ),
    );
    yield* Effect.eventually(
      fixture.manager.status(ref).pipe(
        Effect.filterOrFail(
          (status) => status.phase === "crashed",
          () => new Error("projection did not reach crashed"),
        ),
      ),
    );
    // … while the projection survives at phase "crashed" for reconnecting
    // clients, and only an explicit close discards it (via the ref index).
    assert.equal(yield* isActive(fixture, session.sessionId), false);
    yield* fixture.manager.close(session.sessionId);
    assert.equal(
      yield* fixture.manager.status(ref).pipe(Effect.exit, Effect.map(Exit.isSuccess)),
      false,
    );
  }),
);
