import * as NodeAssert from "node:assert/strict";

import { layer } from "@effect/vitest";
import type { CollectionEvent, SessionRef, SessionScopedEvent } from "@vibest/contract";
import { Effect, Fiber, Stream } from "effect";

import { EventBus, EventBusLayer } from "../src/index";

const ref = (sessionId: string): SessionRef => ({
  projectId: "p1",
  harnessAgentId: "claude-code",
  sessionId,
});

const started = (sessionId: string, seq: number): SessionScopedEvent => ({
  seq,
  ref: ref(sessionId),
  type: "session.turn.started",
  turnId: `t${seq}`,
});

layer(EventBusLayer)("EventBus", (it) => {
  it.effect("delivers only the subscribed session's scoped events", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const stream = yield* bus.subscribe({ kind: "session", ref: ref("a") });
      const collector = yield* Effect.forkChild(Stream.runCollect(stream.pipe(Stream.take(2))));

      yield* bus.publish(started("a", 1));
      yield* bus.publish(started("b", 1));
      yield* bus.publish(started("a", 2));

      const items = yield* Fiber.join(collector);
      const seqs = items.flatMap((item) =>
        item.type === "event" && "seq" in item.event ? [item.event.seq] : [],
      );
      NodeAssert.deepStrictEqual(seqs, [1, 2]);
    }),
  );

  it.effect("a global subscriber sees every session plus collection events", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const stream = yield* bus.subscribe({ kind: "global" });
      const collector = yield* Effect.forkChild(Stream.runCollect(stream.pipe(Stream.take(3))));

      yield* bus.publish(started("a", 1));
      yield* bus.publish(started("b", 1));
      yield* bus.publish({ ref: ref("a"), type: "session.created" } satisfies CollectionEvent);

      const items = yield* Fiber.join(collector);
      NodeAssert.deepStrictEqual(
        items.map((item) => (item.type === "event" ? item.event.type : item.type)),
        ["session.turn.started", "session.turn.started", "session.created"],
      );
    }),
  );
});
