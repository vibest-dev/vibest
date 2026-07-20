import type { SubscribeStreamEvent, SubscriptionScope } from "@vibest/contract";
import { Effect, Exit, Scope, Stream } from "effect";

import type { EventBusShape } from "../events";

/**
 * Open a scoped subscription on the {@link EventBusShape} and hand back a stream
 * whose own scope is torn down when the stream ends — so a client disconnect
 * removes the subscriber from the bus.
 */
export const openScopedSubscription = (
  bus: EventBusShape,
  scope: SubscriptionScope,
): Effect.Effect<Stream.Stream<SubscribeStreamEvent>> =>
  Effect.gen(function* () {
    const subscriptionScope = yield* Scope.make();
    const stream = yield* bus
      .subscribe(scope)
      .pipe(Effect.provideService(Scope.Scope, subscriptionScope));
    return stream.pipe(Stream.ensuring(Scope.close(subscriptionScope, Exit.void)));
  });
