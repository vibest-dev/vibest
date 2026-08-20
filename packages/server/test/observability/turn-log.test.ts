import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import { Context, Effect, Layer, Logger } from "effect";

import { EventBus, EventBusLayer } from "../../src/events";
import { makeHarnessAgentSession } from "../../src/harness/session";
import { structured, type LogRecord } from "../log-record";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
};

const capture = (into: Array<LogRecord>) =>
  Logger.layer([
    Logger.map(structured, (record) => {
      into.push(record);
    }),
  ]);

/**
 * A turn's log is deliberately two lines. These tests are here to keep it that
 * way: the temptation to log "just one more" event inside a turn is what turns
 * a readable log into a transcript nobody reads.
 */
layer(Layer.empty)("turn logging", (it) => {
  // Per-test `Layer.build`: `layer(EventBusLayer)` would memoize one bus for
  // the whole block.
  const session = Effect.gen(function* () {
    const bus = Context.get(yield* Layer.build(EventBusLayer), EventBus);
    return yield* makeHarnessAgentSession(ref, bus);
  });

  it.effect("logs the two bookends and nothing in between", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const context = yield* Layer.build(capture(records));
      const live = yield* session;

      yield* Effect.gen(function* () {
        yield* live.emit({ type: "session.turn.started", turnId: "turn-1" });
        // The content of a turn: hundreds of these in a real one.
        yield* live.emit({
          type: "session.message.chunk",
          turnId: "turn-1",
          chunk: { type: "text-delta", id: "text-1", delta: "hello" },
        });
        yield* live.emit({
          type: "session.turn.ended",
          turnId: "turn-1",
          outcome: "completed",
          usage: { inputTokens: 12, outputTokens: 34 },
        });
      }).pipe(Effect.provide(context));

      assert.equal(records.length, 2);
      const [started, ended] = records;
      assert.ok(started !== undefined && ended !== undefined);

      assert.equal(started.annotations.event, "session.turn.started");
      assert.equal(started.annotations.turnId, "turn-1");
      assert.equal(started.annotations.sessionId, "session-1");

      assert.equal(ended.level, "INFO");
      assert.equal(ended.annotations.outcome, "completed");
      assert.deepEqual(ended.annotations.usage, { inputTokens: 12, outputTokens: 34 });
      // seq is the thread back to the event stream a client saw.
      assert.equal(started.annotations.seq, 1);
      assert.equal(ended.annotations.seq, 3);
    }),
  );

  // A level filter is how a periodic read finds problems, so the outcome has to
  // reach the level — not just an annotation somebody has to go looking for.
  it.effect("raises a failed turn to warn and carries the category", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const context = yield* Layer.build(capture(records));
      const live = yield* session;

      yield* Effect.gen(function* () {
        yield* live.emit({ type: "session.turn.started", turnId: "turn-2" });
        yield* live.emit({
          type: "session.turn.ended",
          turnId: "turn-2",
          outcome: "failed",
          error: { category: "rate_limited", message: "slow down" },
        });
      }).pipe(Effect.provide(context));

      const ended = records[1];
      assert.ok(ended !== undefined);
      assert.equal(ended.level, "WARN");
      assert.equal(ended.annotations.errorCategory, "rate_limited");
      assert.equal(ended.annotations.error, "slow down");
    }),
  );

  // Cancellation is the user's decision, not a problem to surface later.
  it.effect("keeps a canceled turn at info", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const context = yield* Layer.build(capture(records));
      const live = yield* session;

      yield* live
        .emit({ type: "session.turn.ended", turnId: "turn-3", outcome: "canceled" })
        .pipe(Effect.provide(context));

      assert.equal(records[0]?.level, "INFO");
      assert.equal(records[0]?.annotations.outcome, "canceled");
    }),
  );
});
