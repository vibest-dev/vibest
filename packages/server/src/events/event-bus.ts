import type {
  ServerEvent,
  SessionRef,
  SubscribeStreamEvent,
  SubscriptionClosedReason,
  SubscriptionScope,
} from "@vibest/contract";
import { isSessionScopedEvent } from "@vibest/contract";
import { Context, Effect, Layer, Queue, Ref, Scope, Stream, SynchronizedRef } from "effect";
import type * as Cause from "effect/Cause";

const DEFAULT_SUBSCRIBER_CAPACITY = 256;

const refEquals = (a: SessionRef, b: SessionRef): boolean =>
  a.projectId === b.projectId &&
  a.harnessAgentId === b.harnessAgentId &&
  a.sessionId === b.sessionId;

/** Session scope sees only its own scoped events; global is the firehose. */
const matches = (scope: SubscriptionScope, event: ServerEvent): boolean =>
  scope.kind === "global" ? true : isSessionScopedEvent(event) && refEquals(event.ref, scope.ref);

const scopeTargets = (scope: SubscriptionScope, ref: SessionRef): boolean =>
  scope.kind === "session" && refEquals(scope.ref, ref);

type SubscriberState = "active" | "closed";

type Subscriber = {
  readonly id: number;
  readonly scope: SubscriptionScope;
  readonly output: Queue.Queue<SubscribeStreamEvent, Cause.Done>;
  readonly state: SynchronizedRef.SynchronizedRef<SubscriberState>;
};

export type EventBusShape = {
  /** Fan a wire event out to every matching subscriber. */
  readonly publish: (event: ServerEvent) => Effect.Effect<void>;
  /** Terminate a session's subscribers with a reason (close/delete/recovery). */
  readonly closeSession: (ref: SessionRef, reason: SubscriptionClosedReason) => Effect.Effect<void>;
  readonly subscribe: (
    scope: SubscriptionScope,
  ) => Effect.Effect<Stream.Stream<SubscribeStreamEvent>, never, Scope.Scope>;
};

export class EventBus extends Context.Service<EventBus, EventBusShape>()("EventBus") {}

export const makeEventBus = (
  capacity = DEFAULT_SUBSCRIBER_CAPACITY,
): Effect.Effect<EventBusShape> =>
  Effect.gen(function* () {
    const nextSubscriberId = yield* Ref.make(0);
    const subscribers = yield* Ref.make<ReadonlyMap<number, Subscriber>>(new Map());

    const remove = (subscriber: Subscriber) =>
      Ref.update(subscribers, (current) => {
        if (current.get(subscriber.id) !== subscriber) return current;
        const next = new Map(current);
        next.delete(subscriber.id);
        return next;
      });

    /** Serialized per subscriber so the terminal `closed` is emitted at most once. */
    const emitClosed = (subscriber: Subscriber, reason: SubscriptionClosedReason) =>
      SynchronizedRef.modifyEffect(subscriber.state, (current) =>
        current === "closed"
          ? Effect.succeed([undefined, current] as const)
          : Queue.offer(subscriber.output, { type: "closed", reason }).pipe(
              Effect.andThen(Queue.end(subscriber.output)),
              Effect.andThen(remove(subscriber)),
              Effect.as([undefined, "closed"] as const),
            ),
      ).pipe(Effect.catch(() => Effect.void));

    const deliver = (subscriber: Subscriber, event: ServerEvent) => {
      if (!matches(subscriber.scope, event)) return Effect.void;
      return SynchronizedRef.modifyEffect(subscriber.state, (current) => {
        if (current === "closed") return Effect.succeed([undefined, current] as const);
        if (Queue.sizeUnsafe(subscriber.output) < capacity) {
          return Queue.offer(subscriber.output, { type: "event", event }).pipe(
            Effect.as([undefined, current] as const),
          );
        }
        // Bounded queue full: the consumer fell behind. Terminate it.
        return Queue.offer(subscriber.output, { type: "closed", reason: "slow_consumer" }).pipe(
          Effect.andThen(Queue.end(subscriber.output)),
          Effect.andThen(remove(subscriber)),
          Effect.as([undefined, "closed"] as const),
        );
      }).pipe(Effect.catch(() => Effect.void));
    };

    const publish = (event: ServerEvent) =>
      Ref.get(subscribers).pipe(
        Effect.flatMap((active) =>
          Effect.forEach(active.values(), (subscriber) => deliver(subscriber, event), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );

    const closeSession = (ref: SessionRef, reason: SubscriptionClosedReason) =>
      Ref.get(subscribers).pipe(
        Effect.flatMap((active) =>
          Effect.forEach(
            [...active.values()].filter((subscriber) => scopeTargets(subscriber.scope, ref)),
            (subscriber) => emitClosed(subscriber, reason),
            { concurrency: "unbounded", discard: true },
          ),
        ),
      );

    const subscribe = (scope: SubscriptionScope) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const id = yield* Ref.modify(
            nextSubscriberId,
            (current) => [current + 1, current + 1] as const,
          );
          const subscriber: Subscriber = {
            id,
            scope,
            output: yield* Queue.dropping<SubscribeStreamEvent, Cause.Done>(capacity + 1),
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

    return { publish, closeSession, subscribe };
  });

export const EventBusLayer: Layer.Layer<EventBus> = Layer.effect(EventBus, makeEventBus());
