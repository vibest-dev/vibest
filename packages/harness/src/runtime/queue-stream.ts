import { Effect, Exit, Queue, Stream } from "effect";
import type * as Pull from "effect/Pull";

/** Pulls one queue element per stream chunk so takeUntil cannot discard a dequeued tail. */
export const streamFromQueueOne = <A, E>(
  queue: Queue.Dequeue<A, E>,
): Stream.Stream<A, Pull.ExcludeDone<E>> => Stream.fromEffectRepeat(Queue.take(queue));

/** Removes currently buffered values without waiting for future offers. */
export const drainQueue = <A, E>(queue: Queue.Dequeue<A, E>): Effect.Effect<void> =>
  Effect.sync(() => {
    while (true) {
      const next = Queue.takeUnsafe(queue);
      if (!next || Exit.isFailure(next)) return;
    }
  });
