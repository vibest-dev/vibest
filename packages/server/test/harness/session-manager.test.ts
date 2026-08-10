import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import type { ClaudeCodeUIMessageChunk } from "@vibest/contract/claude-code";
import { Deferred, Effect, Exit, Fiber, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import { makeEventBus } from "../../src/events/event-bus";
import type {
  HarnessAgentAdapter,
  HarnessAgentRuntime,
  SessionInfoResult,
  UserInput,
} from "../../src/harness/adapter";
import { AgentOperationError } from "../../src/harness/errors";
import type { SessionEnvelopeDraft, SessionEvent } from "../../src/harness/events/framework";
import { streamFromQueueOne } from "../../src/harness/queue-stream";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";
import { makeHarnessAgentSession } from "../../src/harness/session";
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

  const makeRuntime = (sessionId: string): Effect.Effect<HarnessAgentRuntime, never, Scope.Scope> =>
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
        steer: () => Effect.void,
        setModel: () => Effect.void,
        setReasoningEffort: () => Effect.void,
        setPermissionMode: () => Effect.void,
        interrupt: Effect.void,
        respondToAgentRequest: () => Effect.void,
        getCapabilities: Effect.succeed({
          supportsResume: true,
          supportsPermissions: false,
        }),
        close,
      } satisfies HarnessAgentRuntime;
    });

  const adapter = {
    id: "claude-code",
    descriptor: { id: "claude-code", name: "Claude Code" },
    checkAvailability: Effect.succeed({ available: true }),
    permissionModes: [],
    open: () => makeRuntime("created-session"),
    resume: ({ sessionId }) =>
      Ref.update(resumeCalls, (current) => current + 1).pipe(
        Effect.andThen(Deferred.await(resumeGate)),
        Effect.andThen(makeRuntime(sessionId)),
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
    bus,
    resumeGate,
    resumeCalls,
    closeCalls,
    holdClose,
    closeGate,
    crashGate,
  };
});
type Fixture = Effect.Success<typeof makeFixture>;

/** Liveness probe: `get` succeeds while a session has a runtime, fails once torn down. */
const isActive = (fixture: Fixture, ref: SessionRef) =>
  fixture.manager.get(ref).pipe(Effect.exit, Effect.map(Exit.isSuccess));

it.effect("drains the native stream into the session and tears down on close", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);

    const receipt = yield* session.prompt({ parts: [{ type: "text", text: "hello" }] });
    // The manager's drain folds the emitted turn into the session: 3 events, seq 3.
    const snapshot = yield* Effect.eventually(
      fixture.manager.snapshot(ref).pipe(
        Effect.filterOrFail(
          (current) => current.cursor >= 3,
          () => new Error("session did not catch up"),
        ),
      ),
    );

    yield* fixture.manager.close(ref);

    assert.deepEqual(receipt, { turnId: "turn-1" });
    assert.equal(snapshot.status.phase, "idle");
    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
    assert.equal(yield* isActive(fixture, ref), false);
    // Close discards the session along with its runtime, so the ref falls back
    // to the answer any untouched session gives.
    assert.deepEqual(yield* fixture.manager.status(ref), { phase: "idle" });
    assert.equal((yield* fixture.manager.snapshot(ref)).cursor, 0);
  }),
);

it.effect("keeps one stream id per session generation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("generation");

    const firstAbsent = yield* fixture.manager.snapshot(ref);
    const secondAbsent = yield* fixture.manager.snapshot(ref);
    assert.equal(secondAbsent.streamId, firstAbsent.streamId);

    yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);
    const firstLive = yield* fixture.manager.snapshot(ref);
    assert.equal(firstLive.streamId, firstAbsent.streamId);

    const stream = yield* fixture.bus.subscribe({ kind: "session", ref });
    const eventFiber = yield* Effect.forkChild(Stream.runHead(stream));
    yield* fixture.manager.emit(ref, { type: "session.turn.started", turnId: "turn-1" });
    const item = yield* Fiber.join(eventFiber);
    assert.equal(item._tag, "Some");
    const event =
      item._tag === "Some" && item.value.type === "event" ? item.value.event : undefined;
    assert.equal(event && "streamId" in event ? event.streamId : undefined, firstLive.streamId);
    assert.equal((yield* fixture.manager.snapshot(ref)).streamId, firstLive.streamId);

    yield* fixture.manager.close(ref);
    const secondAbsentGeneration = yield* fixture.manager.snapshot(ref);
    assert.notEqual(secondAbsentGeneration.streamId, firstLive.streamId);
    assert.equal((yield* fixture.manager.snapshot(ref)).streamId, secondAbsentGeneration.streamId);

    yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);
    const secondLive = yield* fixture.manager.snapshot(ref);
    assert.equal(secondLive.streamId, secondAbsentGeneration.streamId);
    yield* fixture.manager.close(ref);

    const restarted = yield* makeFixture;
    assert.notEqual((yield* restarted.manager.snapshot(ref)).streamId, firstAbsent.streamId);
  }),
);

const makeCreationRaceManager = (
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([]);
    const bus = yield* makeEventBus();
    const makeSession: typeof makeHarnessAgentSession = (...args) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(makeHarnessAgentSession(...args)),
      );
    return yield* makeHarnessAgentSessionManager(registry, bus, makeSession).pipe(
      Effect.provide(NodePlatformLayer),
    );
  });

it.effect("close waits for a session materialization that already owns the table permit", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const manager = yield* makeCreationRaceManager(started, release);
    const ref = refFor("creation-close-race");

    const materialize = yield* Effect.forkChild(
      manager.emit(ref, { type: "session.turn.started", turnId: "turn-1" }),
    );
    yield* Deferred.await(started);

    const close = yield* Effect.forkChild(manager.close(ref));
    yield* Effect.yieldNow;
    assert.equal(close.pollUnsafe(), undefined);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(materialize);
    yield* Fiber.join(close);

    assert.equal(yield* manager.liveStatus(ref), undefined);
    assert.equal((yield* manager.snapshot(ref)).cursor, 0);
  }),
);

it.effect("single-flights ensure in owner scope when the first waiter cancels", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const ref = refFor("resumed");
    const first = yield* Effect.forkChild(fixture.manager.ensureRuntime(input, ref));
    const second = yield* Effect.forkChild(fixture.manager.ensureRuntime(input, ref));

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
    assert.equal(yield* isActive(fixture, ref), true);
    yield* fixture.manager.close(ref);
  }),
);

it.effect("waits for an in-flight close before reopening the same session id", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    const session = yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);
    const closingStreamId = (yield* fixture.manager.snapshot(ref)).streamId;
    yield* Ref.set(fixture.holdClose, true);
    const close = yield* Effect.forkChild(fixture.manager.close(ref));
    yield* Effect.eventually(
      Ref.get(fixture.closeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("close did not start"),
        ),
      ),
    );
    assert.equal((yield* fixture.manager.snapshot(ref)).streamId, closingStreamId);
    const resume = yield* Effect.forkChild(
      fixture.manager.ensureRuntime(
        { sessionId: session.sessionId, harnessAgentId: "claude-code" },
        ref,
      ),
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

    assert.equal(yield* isActive(fixture, ref), true);
    assert.notEqual((yield* fixture.manager.snapshot(ref)).streamId, closingStreamId);
    yield* fixture.manager.close(ref);
  }),
);

it.effect("closes a session that is still being resumed", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const input = { sessionId: "resumed-session", harnessAgentId: "claude-code" } as const;
    const ref = refFor("resumed");
    const resume = yield* Effect.forkChild(fixture.manager.ensureRuntime(input, ref));
    yield* Effect.eventually(
      Ref.get(fixture.resumeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("ensure did not start"),
        ),
      ),
    );
    const close = yield* Effect.forkChild(fixture.manager.close(ref));

    yield* Deferred.succeed(fixture.resumeGate, undefined);
    yield* Fiber.join(resume);
    yield* Fiber.join(close);

    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
    assert.equal(yield* isActive(fixture, ref), false);
  }),
);

it.effect("shares one idempotent close operation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);
    const first = yield* Effect.forkChild(fixture.manager.close(ref));
    const second = yield* Effect.forkChild(fixture.manager.close(ref));

    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(yield* Ref.get(fixture.closeCalls), 1);
  }),
);

it.effect("a crash releases the runtime but keeps the session queryable", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const ref = refFor("created");
    yield* fixture.manager.open("claude-code", { cwd: "/tmp" }, {}, ref);

    yield* Deferred.succeed(fixture.crashGate, undefined);
    // The crash closes the native runtime (onCrash) …
    yield* Effect.eventually(
      Ref.get(fixture.closeCalls).pipe(
        Effect.filterOrFail(
          (calls) => calls === 1,
          () => new Error("crash did not close the runtime"),
        ),
      ),
    );
    yield* Effect.eventually(
      fixture.manager.status(ref).pipe(
        Effect.filterOrFail(
          (status) => status.phase === "crashed",
          () => new Error("session did not reach crashed"),
        ),
      ),
    );
    // … while the session survives at phase "crashed" for reconnecting
    // clients, and only an explicit close discards it.
    assert.equal(yield* isActive(fixture, ref), false);
    yield* fixture.manager.close(ref);
    assert.deepEqual(yield* fixture.manager.status(ref), { phase: "idle" });
  }),
);
