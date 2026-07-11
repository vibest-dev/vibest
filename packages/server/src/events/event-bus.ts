import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect";

import type { SessionEvent } from "../types";

/** An event as delivered to subscribers, tagged with a monotonic sequence. */
export interface EventEnvelope {
  readonly seq: number;
  readonly event: SessionEvent;
}

/**
 * `events` hub: session events are published here and broadcast to every
 * subscriber (all connections share one stream, not filtered per-connection).
 * `seq` is monotonic so clients can detect gaps.
 *
 * Backpressure/drop thresholds, `gap` merging and `ping` heartbeat are not
 * wired yet (design §4.3 / §8) — this is the minimal publish/subscribe core.
 */
export class EventBus extends Context.Service<
  EventBus,
  {
    readonly publish: (event: SessionEvent) => Effect.Effect<void>;
    readonly subscribe: () => Stream.Stream<EventEnvelope>;
  }
>()("EventBus") {}

export const EventBusLayer: Layer.Layer<EventBus> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<EventEnvelope>();
    const seqRef = yield* Ref.make(0);

    return {
      publish: (event) =>
        Effect.gen(function* () {
          const seq = yield* Ref.modify(seqRef, (n) => [n + 1, n + 1] as const);
          yield* PubSub.publish(pubsub, { seq, event });
        }),
      subscribe: () => Stream.fromPubSub(pubsub),
    };
  }),
);
