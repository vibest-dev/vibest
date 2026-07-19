import {
  isSessionEvent,
  type HarnessAgentId,
  type SessionEnvelope,
  type SessionEnvelopeDraft,
} from "@vibest/contract";
import { Context, Effect, Layer, Queue, Ref, Scope, Stream, SynchronizedRef } from "effect";
import type * as Cause from "effect/Cause";

import { SessionEventPublisher, type SessionEventPublisherShape } from "../harness";

const DEFAULT_SUBSCRIBER_CAPACITY = 256;

export type EventBusFilter = {
  readonly sessionId?: string;
  readonly harnessAgentId?: HarnessAgentId;
};

export type EventBusGap = {
  readonly type: "gap";
  readonly cursor: number;
  readonly terminal: boolean;
};

export type EventBusItem =
  | { readonly type: "event"; readonly event: SessionEnvelope }
  | EventBusGap;

type SubscriberState = "active" | "gapped" | "terminal";

type Subscriber = {
  readonly id: number;
  readonly filter: EventBusFilter;
  readonly output: Queue.Queue<EventBusItem, Cause.Done>;
  readonly state: SynchronizedRef.SynchronizedRef<SubscriberState>;
};

export type EventBusShape = SessionEventPublisherShape & {
  readonly cursor: Effect.Effect<number>;
  readonly subscribe: (
    filter?: EventBusFilter,
  ) => Effect.Effect<Stream.Stream<EventBusItem>, never, Scope.Scope>;
};

export class EventBus extends Context.Service<EventBus, EventBusShape>()("EventBus") {}

const matches = (filter: EventBusFilter, event: SessionEnvelope): boolean =>
  (filter.sessionId === undefined || filter.sessionId === event.sessionId) &&
  (filter.harnessAgentId === undefined || filter.harnessAgentId === event.harnessAgentId);

const isDroppable = (event: SessionEnvelope): boolean =>
  !isSessionEvent(event.body) && event.body.type.endsWith("-delta");

export const makeEventBus = (
  capacity = DEFAULT_SUBSCRIBER_CAPACITY,
): Effect.Effect<EventBusShape> =>
  Effect.gen(function* () {
    const sequence = yield* SynchronizedRef.make(0);
    const nextSubscriberId = yield* Ref.make(0);
    const subscribers = yield* Ref.make<ReadonlyMap<number, Subscriber>>(new Map());

    const remove = (subscriber: Subscriber) =>
      Ref.update(subscribers, (current) => {
        if (current.get(subscriber.id) !== subscriber) return current;
        const next = new Map(current);
        next.delete(subscriber.id);
        return next;
      });

    const terminate = (subscriber: Subscriber, cursor: number) =>
      Effect.sync(() => {
        while (Queue.takeUnsafe(subscriber.output) !== undefined) {
          // Clear queued data without ever waiting for a consumer.
        }
      }).pipe(
        Effect.andThen(Queue.offer(subscriber.output, { type: "gap", cursor, terminal: true })),
        Effect.andThen(Queue.end(subscriber.output)),
        Effect.andThen(remove(subscriber)),
        Effect.asVoid,
      );

    const deliver = (subscriber: Subscriber, event: SessionEnvelope) => {
      if (!matches(subscriber.filter, event)) return Effect.void;
      return SynchronizedRef.modifyEffect(subscriber.state, (current) => {
        if (current === "terminal") return Effect.succeed([undefined, current] as const);
        const size = Queue.sizeUnsafe(subscriber.output);
        if (size < capacity) {
          return Queue.offer(subscriber.output, { type: "event", event }).pipe(
            Effect.as([undefined, current] as const),
          );
        }
        if (isDroppable(event)) {
          if (current === "gapped") return Effect.succeed([undefined, current] as const);
          return Queue.offer(subscriber.output, {
            type: "gap",
            cursor: event.seq,
            terminal: false,
          }).pipe(Effect.as([undefined, "gapped"] as const));
        }
        return terminate(subscriber, event.seq).pipe(Effect.as([undefined, "terminal"] as const));
      }).pipe(Effect.catch(() => Effect.void));
    };

    const publish = (draft: SessionEnvelopeDraft) =>
      SynchronizedRef.modifyEffect(sequence, (current) => {
        const seq = current + 1;
        const event = { ...draft, seq } as SessionEnvelope;
        return Ref.get(subscribers).pipe(
          Effect.flatMap((active) =>
            Effect.forEach(active.values(), (subscriber) => deliver(subscriber, event), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.as([seq, seq] as const),
        );
      });

    const subscribe = (filter: EventBusFilter = {}) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const id = yield* Ref.modify(
            nextSubscriberId,
            (current) => [current + 1, current + 1] as const,
          );
          const subscriber: Subscriber = {
            id,
            filter,
            output: yield* Queue.dropping<EventBusItem, Cause.Done>(capacity + 1),
            state: yield* SynchronizedRef.make<SubscriberState>("active"),
          };
          yield* Ref.update(subscribers, (current) =>
            new Map(current).set(subscriber.id, subscriber),
          );
          return subscriber;
        }),
        (subscriber) =>
          remove(subscriber).pipe(Effect.andThen(Queue.end(subscriber.output)), Effect.asVoid),
      ).pipe(Effect.map((subscriber) => Stream.fromQueue(subscriber.output)));

    return {
      publish,
      cursor: Ref.get(sequence),
      subscribe,
    };
  });

export const EventBusLayer: Layer.Layer<EventBus | SessionEventPublisher> = Layer.effectContext(
  makeEventBus().pipe(
    Effect.map((bus) => Context.make(EventBus, bus).pipe(Context.add(SessionEventPublisher, bus))),
  ),
);
