import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef, SessionScopedEvent } from "@vibest/contract";
import { Effect, Stream } from "effect";

import { makeEventBus } from "../src/events";

const ref: SessionRef = { projectId: "p1", harnessAgentId: "claude-code", sessionId: "s1" };

const started = (seq: number): SessionScopedEvent => ({
  seq,
  ref,
  type: "session.turn.started",
  turnId: `t${seq}`,
});

it.effect("terminates a slow consumer once its bounded queue overflows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(2);
      const stream = yield* bus.subscribe({ kind: "session", ref });

      // Nothing drains the subscriber, so the third event overflows capacity.
      yield* bus.publish(started(1));
      yield* bus.publish(started(2));
      yield* bus.publish(started(3));

      const items = yield* Stream.runCollect(stream.pipe(Stream.take(3)));
      assert.deepStrictEqual(
        items.map((item) => item.type),
        ["event", "event", "closed"],
      );
      assert.deepStrictEqual(items[2], { type: "closed", reason: "slow_consumer" });
    }),
  ),
);

it.effect("closeSession ends a matching subscriber with its reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(8);
      const stream = yield* bus.subscribe({ kind: "session", ref });

      yield* bus.publish(started(1));
      yield* bus.closeSession(ref, "session_closed");

      const items = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(
        items.map((item) => item.type),
        ["event", "closed"],
      );
      assert.deepStrictEqual(items.at(-1), { type: "closed", reason: "session_closed" });
    }),
  ),
);
