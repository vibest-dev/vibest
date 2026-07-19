import * as NodeAssert from "node:assert/strict";

import { layer } from "@effect/vitest";
import type { SessionEnvelopeDraft } from "@vibest/contract";
import { Effect, Fiber, Stream } from "effect";

import { EventBus, EventBusLayer } from "../src/index";

const evt = (sessionId: string): SessionEnvelopeDraft => ({
  sessionId,
  harnessAgentId: "claude-code",
  body: { type: "session.turn.started", sessionId, turnId: "t1" },
});

layer(EventBusLayer)("EventBus", (it) => {
  it.effect("broadcasts published events with a monotonic seq", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const subscription = yield* bus.subscribe();
      const collector = yield* Effect.forkChild(
        Stream.runCollect(subscription.pipe(Stream.take(2))),
      );

      yield* bus.publish(evt("a"));
      yield* bus.publish(evt("b"));
      const items = yield* Fiber.join(collector);
      const events = items.filter((item) => item.type === "event");

      NodeAssert.deepStrictEqual(
        events.map((item) => item.event.sessionId),
        ["a", "b"],
      );
      NodeAssert.deepStrictEqual(
        events.map((item) => item.event.seq),
        [1, 2],
      );
    }),
  );
});
