import { Effect, Exit, Scope, Stream } from "effect";

import type { EventBusFilter, EventBusItem, EventBusShape } from "../events";

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
