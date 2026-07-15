import { AgentOperationError } from "@vibest/harness/runtime";
import { Effect, Exit, Scope, Stream } from "effect";

import type { EventBusFilter, EventBusItem, EventBusShape } from "../events";

type PublishedEvent = Extract<EventBusItem, { readonly type: "event" }>;

export type ScopedEventSubscription = {
  readonly events: Stream.Stream<PublishedEvent, AgentOperationError>;
  readonly close: Effect.Effect<void>;
};

export type ScopedRawEventSubscription = {
  readonly events: Stream.Stream<EventBusItem>;
  readonly close: Effect.Effect<void>;
};

export const openRawEventSubscription = (
  bus: EventBusShape,
  filter: EventBusFilter,
): Effect.Effect<ScopedRawEventSubscription> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const stream = yield* bus.subscribe(filter).pipe(Effect.provideService(Scope.Scope, scope));
    const close = Scope.close(scope, Exit.void);
    return { events: stream.pipe(Stream.ensuring(close)), close };
  });

export const openEventSubscription = (
  bus: EventBusShape,
  filter: EventBusFilter,
): Effect.Effect<ScopedEventSubscription> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const stream = yield* bus.subscribe(filter).pipe(Effect.provideService(Scope.Scope, scope));
    const close = Scope.close(scope, Exit.void);
    return {
      events: stream.pipe(
        Stream.mapEffect(
          (item): Effect.Effect<PublishedEvent, AgentOperationError> =>
            item.type === "event"
              ? Effect.succeed(item)
              : Effect.fail(
                  new AgentOperationError({
                    sessionId: filter.sessionId ?? "*",
                    operation: item.terminal
                      ? "event-subscription-terminated"
                      : "event-subscription-gap",
                    cause: new Error(`Event subscription gapped at cursor ${item.cursor}`),
                  }),
                ),
        ),
        Stream.ensuring(close),
      ),
      close,
    };
  });
