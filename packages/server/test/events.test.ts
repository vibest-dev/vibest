import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { EventBus, EventBusLayer, type SessionEvent } from "../src/index";

const evt = (type: string): SessionEvent => ({
  sessionId: "claude-code:1",
  harnessAgentId: "claude-code",
  type,
  payload: null,
});

describe("EventBus", () => {
  it("broadcasts published events with a monotonic seq", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus;
      const collector = yield* Effect.forkChild(
        Stream.runCollect(bus.subscribe().pipe(Stream.take(2))),
      );
      // give the subscription time to attach before publishing
      yield* Effect.sleep("50 millis");
      yield* bus.publish(evt("a"));
      yield* bus.publish(evt("b"));
      return yield* Fiber.join(collector);
    });

    const envelopes = await Effect.runPromise(Effect.provide(program, EventBusLayer));
    expect(envelopes.map((e) => e.event.type)).toEqual(["a", "b"]);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
  });
});
