import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionEnvelopeDraft } from "@vibest/contract";
import { Effect, Stream } from "effect";

import { makeEventBus } from "../src/events";

const draft = (sessionId: string, body: SessionEnvelopeDraft["body"]): SessionEnvelopeDraft =>
  ({ harnessAgentId: "claude-code", sessionId, body }) as SessionEnvelopeDraft;

const delta = (sessionId: string, index: number) =>
  draft(sessionId, { type: "text-delta", id: "text", delta: String(index) });

const control = (sessionId: string) => draft(sessionId, { type: "session.updated", sessionId });

it.effect("drops an overflowing delta and emits one observable gap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(2);
      const subscription = yield* bus.subscribe();

      yield* bus.publish(delta("session", 1));
      yield* bus.publish(delta("session", 2));
      yield* bus.publish(delta("session", 3));
      const items = yield* Stream.runCollect(subscription.pipe(Stream.take(3)));

      NodeAssert.deepStrictEqual(
        items.map((item) => item.type),
        ["event", "event", "gap"],
      );
      NodeAssert.deepStrictEqual(items[2], { type: "gap", cursor: 3, terminal: false });
    }),
  ),
);

it.effect("replaces a full subscriber queue with a terminal gap for control events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(2);
      const subscription = yield* bus.subscribe();

      yield* bus.publish(control("session"));
      yield* bus.publish(control("session"));
      yield* bus.publish(control("session"));
      const items = yield* Stream.runCollect(subscription);

      NodeAssert.deepStrictEqual(items, [{ type: "gap", cursor: 3, terminal: true }]);
    }),
  ),
);

it.effect("preserves delivery order across concurrent publishers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(128);
      const subscription = yield* bus.subscribe();

      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        (index) => bus.publish(delta("session", index)),
        { concurrency: "unbounded", discard: true },
      );
      const items = yield* Stream.runCollect(subscription.pipe(Stream.take(100)));

      NodeAssert.deepStrictEqual(
        items.map((item) => (item.type === "event" ? item.event.seq : -1)),
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
    }),
  ),
);

it.effect("filters subscriptions without affecting sequence numbers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* makeEventBus(4);
      const subscription = yield* bus.subscribe({ sessionId: "wanted" });

      yield* bus.publish(control("other"));
      yield* bus.publish(control("wanted"));
      const item = yield* Stream.runHead(subscription);

      NodeAssert.equal(item._tag, "Some");
      if (item._tag === "Some" && item.value.type === "event") {
        NodeAssert.equal(item.value.event.seq, 2);
        NodeAssert.equal(item.value.event.sessionId, "wanted");
      }
    }),
  ),
);
