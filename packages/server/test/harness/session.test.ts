import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import { Context, Effect, Layer, Queue, Ref, Stream } from "effect";
import type * as Cause from "effect/Cause";

import { EventBus, EventBusLayer } from "../../src/events";
import { AgentOperationError, type SessionEnvelopeBody } from "../../src/harness";
import type { HarnessAgentRuntime } from "../../src/harness/adapter";
import { AgentUnavailable } from "../../src/harness/errors";
import { streamFromQueueOne } from "../../src/harness/queue-stream";
import { type HarnessAgentSessionShape, makeHarnessAgentSession } from "../../src/harness/session";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
};

// A session is a private collaborator of the manager (no Context tag in
// production); the test wraps the factory in a local tag for wiring.
class SessionService extends Context.Service<SessionService, HarnessAgentSessionShape>()(
  "test/SessionService",
) {}

const SessionServiceLayer = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const bus = yield* EventBus;
    return yield* makeHarnessAgentSession(ref, bus);
  }),
);

// The native id the harness stamps on its own events; the session must strip
// it and key everything by the server-side ref instead.
const nativeId = "native-1";

const makeQueue = Queue.bounded<SessionEnvelopeBody, Cause.Done | AgentOperationError>(32);

type EventQueue = Effect.Success<typeof makeQueue>;

/** A runtime that is nothing but its event stream and a close counter — the
 * session under test never calls anything else on it. */
const runtimeFrom = (
  queue: EventQueue,
  options: { readonly closes?: Ref.Ref<number>; readonly models?: Ref.Ref<Array<string>> } = {},
): HarnessAgentRuntime => ({
  sessionId: nativeId,
  harnessAgentId: "claude-code",
  events: streamFromQueueOne(queue).pipe(
    Stream.map((body) => ({ harnessAgentId: "claude-code" as const, sessionId: nativeId, body })),
  ),
  prompt: () => Effect.succeed({ turnId: "turn-1" }),
  steer: () => Effect.void,
  setModel: (model) =>
    options.models ? Ref.update(options.models, (seen) => [...seen, model]) : Effect.void,
  setReasoningEffort: () => Effect.void,
  setPermissionMode: () => Effect.void,
  interrupt: Effect.void,
  respondToAgentRequest: () => Effect.void,
  getCapabilities: Effect.succeed({
    supportsResume: true,
    supportsPermissions: false,
  }),
  close: options.closes ? Ref.update(options.closes, (count) => count + 1) : Effect.void,
});

const layer = SessionServiceLayer.pipe(Layer.provide(EventBusLayer));

const run = <A, E>(program: Effect.Effect<A, E, SessionService>) =>
  program.pipe(Effect.provide(layer));

const awaitCursor = (session: HarnessAgentSessionShape, at: number) =>
  Effect.eventually(
    session.snapshot.pipe(
      Effect.filterOrFail(
        (snapshot) => snapshot.cursor >= at,
        () => new Error(`cursor did not reach ${at}`),
      ),
    ),
  );

const awaitPhase = (session: HarnessAgentSessionShape, phase: string) =>
  Effect.eventually(
    session.status.pipe(
      Effect.filterOrFail(
        (status) => status.phase === phase,
        () => new Error(`phase did not reach ${phase}`),
      ),
    ),
  );

const crashQueue = (queue: EventQueue) =>
  Queue.fail(
    queue,
    new AgentOperationError({ sessionId: nativeId, operation: "events", cause: "boom" }),
  );

// The reason snapshot/status are total: after a restart every persisted
// session is in exactly this state, and a client must be able to attach,
// snapshot, and subscribe to it without anything starting a process.
it.effect("a session that never had a runtime reads as idle at cursor 0", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      assert.equal(yield* session.peekRuntime, undefined);
      const snapshot = yield* session.snapshot;
      assert.equal(snapshot.status.phase, "idle");
      assert.equal(snapshot.cursor, 0);
      assert.equal(snapshot.activeTurn, null);
      assert.equal(snapshot.activePrompt, null);
      assert.deepEqual(snapshot.pendingRequests, []);
    }),
  ),
);

it.effect("seeds every runtime it acquires with the config it was told to keep", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const models = yield* Ref.make<Array<string>>([]);
      // Nothing is running, so this only records — and it must still succeed:
      // picking a model for a session you have not written to yet is ordinary.
      yield* session.setConfig({ model: "opus" });
      assert.deepEqual(yield* Ref.get(models), []);

      const first = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(first, { models })));
      assert.deepEqual(yield* Ref.get(models), ["opus"]);

      // A live runtime takes the change immediately …
      yield* session.setConfig({ model: "sonnet" });
      assert.deepEqual(yield* Ref.get(models), ["opus", "sonnet"]);

      // … and the accumulated choice — not the create-time one — is what the
      // replacement is seeded with, so a crash does not quietly revert the
      // session to the harness default.
      yield* crashQueue(first);
      yield* awaitPhase(session, "crashed");
      const replacement = yield* Ref.make<Array<string>>([]);
      const second = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(second, { models: replacement })));
      assert.deepEqual(yield* Ref.get(replacement), ["sonnet"]);
    }),
  ),
);

it.effect("ensureRuntime keeps the runtime it holds and stamps contiguous seqs", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const first = yield* makeQueue;
      const second = yield* makeQueue;
      const held = yield* session.ensureRuntime(Effect.succeed(runtimeFrom(first)));
      // A session that already holds a runtime acquires nothing — the second
      // stream must never be consumed, or the single-consumer native stream
      // would split across two drain fibers.
      const again = yield* session.ensureRuntime(Effect.succeed(runtimeFrom(second)));
      assert.equal(again, held);

      yield* Queue.offer(first, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* Queue.offer(first, { type: "start" });
      yield* Queue.offer(first, {
        type: "session.turn.ended",
        sessionId: nativeId,
        turnId: "turn-1",
        outcome: "completed",
      });
      const snapshot = yield* awaitCursor(session, 3);

      assert.equal(snapshot.status.phase, "idle");
      // The finished turn's buffer is retained, marked complete, for recovery.
      assert.equal(snapshot.activeTurn?.complete, true);
      assert.deepEqual(
        snapshot.activeTurn?.chunks.map((chunk) => chunk.seq),
        [2],
      );
      assert.equal(snapshot.status.activeTurnId, undefined);
      // The losing stream was never drained.
      assert.equal(yield* Queue.size(second), 0);
      yield* Queue.offer(second, { type: "start" });
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(second), 1);
    }),
  ),
);

it.effect("concurrent acquisitions run the acquire exactly once", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      const acquisitions = yield* Ref.make(0);
      const acquire = Ref.update(acquisitions, (count) => count + 1).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.as(runtimeFrom(queue)),
      );

      const runtimes = yield* Effect.all(
        Array.from({ length: 8 }, () => session.ensureRuntime(acquire)),
        { concurrency: "unbounded" },
      );

      // Adapters may assume they are never asked to open the same session
      // twice at once; pi's openSession blind-writes its table and would leak
      // a child otherwise.
      assert.equal(yield* Ref.get(acquisitions), 1);
      assert.equal(new Set(runtimes).size, 1);
    }),
  ),
);

it.effect("a failed acquisition holds nothing and lets a later one retry", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const failed = yield* Effect.exit(
        session.ensureRuntime(
          Effect.fail(new AgentUnavailable({ harnessAgentId: "claude-code", reason: "not today" })),
        ),
      );
      assert.equal(failed._tag, "Failure");
      // Still observable, still holding nothing …
      assert.equal(yield* session.peekRuntime, undefined);
      assert.equal((yield* session.status).phase, "idle");

      // … and the next attempt is free to succeed.
      const queue = yield* makeQueue;
      const runtime = yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue)));
      assert.equal(yield* session.peekRuntime, runtime);
    }),
  ),
);

it.effect("a chunk after turn.ended is dropped without consuming a seq", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue)));
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* Queue.offer(queue, {
        type: "session.turn.ended",
        sessionId: nativeId,
        turnId: "turn-1",
        outcome: "completed",
      });
      // A straggler chunk delivered after the turn ended has no turn to belong
      // to: it is dropped outright — never published, never buffered, no seq.
      yield* Queue.offer(queue, { type: "start" });
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-2",
      });
      const snapshot = yield* awaitCursor(session, 3);
      // seq 3 (not 4) proves the straggler consumed no seq; the fresh turn's
      // empty buffer proves it was not appended anywhere.
      assert.equal(snapshot.cursor, 3);
      assert.equal(snapshot.activeTurn?.turnId, "turn-2");
      assert.deepEqual(snapshot.activeTurn?.chunks, []);
    }),
  ),
);

it.effect("a crashed runtime is released but the session survives it", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      const closes = yield* Ref.make(0);
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue, { closes })));
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* awaitPhase(session, "running");

      yield* crashQueue(queue);
      yield* awaitPhase(session, "crashed");
      // The dead runtime is disowned and closed …
      yield* Effect.eventually(
        Ref.get(closes).pipe(
          Effect.filterOrFail(
            (count) => count === 1,
            () => new Error("the crashed runtime was not released"),
          ),
        ),
      );
      assert.equal(yield* session.peekRuntime, undefined);
      // … while the session it belonged to is still queryable.
      const snapshot = yield* session.snapshot;
      assert.equal(snapshot.status.phase, "crashed");
      assert.equal(snapshot.activeTurn, null);
    }),
  ),
);

it.effect("acquiring after a crash starts over without rewinding seq", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const crashing = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(crashing)));
      yield* Queue.offer(crashing, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* awaitCursor(session, 1);
      yield* crashQueue(crashing);
      // turn.started (1) then session.crashed (2).
      yield* awaitCursor(session, 2);

      const queue = yield* makeQueue;
      const replacement = runtimeFrom(queue);
      // Retried: the crashed runtime disowns itself asynchronously.
      yield* Effect.eventually(
        session.ensureRuntime(Effect.succeed(replacement)).pipe(
          Effect.filterOrFail(
            (runtime) => runtime === replacement,
            () => new Error("still holding the crashed runtime"),
          ),
        ),
      );
      // The crash was the runtime ending, not the session: it is idle again.
      assert.equal((yield* session.status).phase, "idle");

      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-2",
      });
      const snapshot = yield* awaitCursor(session, 3);
      assert.equal(snapshot.status.phase, "running");
      // seq carries across the replacement. Restarting it at 0 would put every
      // later event at or below the cursor clients are still holding, and they
      // would discard the lot as already applied.
      assert.equal(snapshot.cursor, 3);
      assert.equal(snapshot.activeTurn?.turnId, "turn-2");
    }),
  ),
);

it.effect("releaseRuntime stops the drain and leaves the session readable", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      const closes = yield* Ref.make(0);
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue, { closes })));
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* awaitPhase(session, "running");

      yield* session.releaseRuntime;
      assert.equal(yield* Ref.get(closes), 1);
      assert.equal(yield* session.peekRuntime, undefined);
      // What the session had folded is still readable — losing a runtime is
      // not losing the session.
      assert.equal((yield* session.status).phase, "running");
      // But nothing consumes the stream any more, so nothing more is folded.
      yield* Queue.offer(queue, {
        type: "session.turn.ended",
        sessionId: nativeId,
        turnId: "turn-1",
        outcome: "completed",
      });
      yield* Effect.yieldNow;
      assert.equal((yield* session.snapshot).cursor, 1);
    }),
  ),
);

it.effect("a naturally ending stream frees the session for a fresh runtime", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const ending = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(ending)));
      yield* Queue.end(ending);

      const queue = yield* makeQueue;
      const replacement = runtimeFrom(queue);
      // A runtime that exited cleanly must stop counting as held, or a session
      // whose agent quit could never start another one.
      yield* Effect.eventually(
        session.ensureRuntime(Effect.succeed(replacement)).pipe(
          Effect.filterOrFail(
            (runtime) => runtime === replacement,
            () => new Error("the ended runtime is still held"),
          ),
        ),
      );
    }),
  ),
);

it.effect("bounds the active turn buffer and marks it truncated on overflow", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue)));
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      // Three ~4MiB deltas cross the 10MiB byte cap; eviction keeps the
      // newest tail.
      const big = "x".repeat(4 * 1024 * 1024);
      for (let index = 0; index < 3; index += 1) {
        yield* Queue.offer(queue, { type: "text-delta", id: "t", delta: big });
      }
      const snapshot = yield* awaitCursor(session, 4);
      assert.equal(snapshot.activeTurn?.truncated, true);
      // The retained tail stays within the cap and keeps the newest chunks.
      assert.equal((snapshot.activeTurn?.chunks.length ?? 0) < 3, true);
      assert.equal(snapshot.activeTurn?.chunks.at(-1)?.seq, 4);
    }),
  ),
);

it.effect("a turn under the buffer caps is not marked truncated", () =>
  run(
    Effect.gen(function* () {
      const session = yield* SessionService;
      const queue = yield* makeQueue;
      yield* session.ensureRuntime(Effect.succeed(runtimeFrom(queue)));
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* Queue.offer(queue, { type: "text-delta", id: "t", delta: "hello" });
      const snapshot = yield* awaitCursor(session, 2);
      assert.equal(snapshot.activeTurn?.truncated, false);
      assert.equal(snapshot.activeTurn?.chunks.length, 1);
    }),
  ),
);
