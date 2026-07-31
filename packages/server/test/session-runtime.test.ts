import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import { Effect, Exit, Layer, Queue, Ref, Stream } from "effect";
import type * as Cause from "effect/Cause";

import { EventBusLayer } from "../src/events";
import { AgentOperationError, type SessionEnvelopeBody } from "../src/harness";
import { streamFromQueueOne } from "../src/harness/queue-stream";
import { SessionManager, SessionManagerLayer } from "../src/session/runtime";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
};

// The native id the harness stamps on its own events; the runtime must strip
// it and key everything by the server-side ref instead.
const nativeId = "native-1";

const makeQueue = Queue.bounded<SessionEnvelopeBody, Cause.Done | AgentOperationError>(32);

const layer = SessionManagerLayer.pipe(Layer.provide(EventBusLayer));

const run = <A, E>(program: Effect.Effect<A, E, SessionManager>) =>
  program.pipe(Effect.provide(layer));

const awaitCursor = (manager: SessionManager["Service"], at: number) =>
  Effect.eventually(
    manager.snapshot(ref).pipe(
      Effect.filterOrFail(
        (snapshot) => snapshot.cursor >= at,
        () => new Error(`cursor did not reach ${at}`),
      ),
    ),
  );

const awaitPhase = (manager: SessionManager["Service"], phase: string) =>
  Effect.eventually(
    manager.status(ref).pipe(
      Effect.filterOrFail(
        (status) => status.phase === phase,
        () => new Error(`phase did not reach ${phase}`),
      ),
    ),
  );

it.effect("start is idempotent for a live runtime and stamps contiguous seqs", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const first = yield* makeQueue;
      const second = yield* makeQueue;
      yield* manager.start(ref, streamFromQueueOne(first));
      // A live runtime makes the second start a no-op — the second stream must
      // never be consumed, or the single-consumer native stream would split.
      yield* manager.start(ref, streamFromQueueOne(second));

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
      const snapshot = yield* awaitCursor(manager, 3);

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

it.effect("a chunk after turn.ended is dropped without consuming a seq", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const queue = yield* makeQueue;
      yield* manager.start(ref, streamFromQueueOne(queue));
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
      const snapshot = yield* awaitCursor(manager, 3);
      // seq 3 (not 4) proves the straggler consumed no seq; the fresh turn's
      // empty buffer proves it was not appended anywhere.
      assert.equal(snapshot.cursor, 3);
      assert.equal(snapshot.activeTurn?.turnId, "turn-2");
      assert.deepEqual(snapshot.activeTurn?.chunks, []);
    }),
  ),
);

it.effect("a crashed stream keeps the projection queryable and runs onCrash once", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const queue = yield* makeQueue;
      const closed = yield* Ref.make(0);
      yield* manager.start(ref, streamFromQueueOne(queue), {
        onCrash: Ref.update(closed, (count) => count + 1),
      });
      yield* Queue.offer(queue, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-1",
      });
      yield* awaitPhase(manager, "running");

      yield* Queue.fail(
        queue,
        new AgentOperationError({ sessionId: nativeId, operation: "events", cause: "boom" }),
      );
      yield* awaitPhase(manager, "crashed");
      yield* Effect.eventually(
        Ref.get(closed).pipe(
          Effect.filterOrFail(
            (count) => count === 1,
            () => new Error("onCrash did not run"),
          ),
        ),
      );
      // The projection stays queryable until close/delete/resume.
      const snapshot = yield* manager.snapshot(ref);
      assert.equal(snapshot.status.phase, "crashed");
      assert.equal(snapshot.activeTurn, null);
    }),
  ),
);

it.effect("start replaces a crashed runtime with a fresh projection", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const crashing = yield* makeQueue;
      yield* manager.start(ref, streamFromQueueOne(crashing));
      yield* Queue.fail(
        crashing,
        new AgentOperationError({ sessionId: nativeId, operation: "events", cause: "boom" }),
      );
      yield* awaitPhase(manager, "crashed");

      const replacement = yield* makeQueue;
      yield* manager.start(ref, streamFromQueueOne(replacement));
      yield* Queue.offer(replacement, {
        type: "session.turn.started",
        sessionId: nativeId,
        turnId: "turn-2",
      });
      const snapshot = yield* awaitCursor(manager, 1);
      assert.equal(snapshot.status.phase, "running");
      // seq restarts with the replacement runtime.
      assert.equal(snapshot.cursor, 1);
      assert.equal(snapshot.activeTurn?.turnId, "turn-2");
    }),
  ),
);

it.effect("stop removes the runtime", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      const queue = yield* makeQueue;
      yield* manager.start(ref, streamFromQueueOne(queue));
      yield* manager.stop(ref);
      const exit = yield* Effect.exit(manager.status(ref));
      assert.equal(Exit.isFailure(exit), true);
    }),
  ),
);

it.effect("a naturally ending stream removes its runtime", () =>
  run(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.start(ref, Stream.empty);
      yield* Effect.eventually(
        Effect.exit(manager.status(ref)).pipe(
          Effect.filterOrFail(Exit.isFailure, () => new Error("runtime was not removed")),
        ),
      );
    }),
  ),
);
