import { Cause, type Duration, Effect, FiberMap, FiberSet, Stream } from "effect"

import { Bus, type BusEvent } from "./bus.ts"

type EventOf<T extends BusEvent["type"]> = Extract<BusEvent, { readonly type: T }>

export const logFailure =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`${what}: ${Cause.pretty(cause)}`),
      ),
    )

export const make = Effect.gen(function* () {
  const bus = yield* Bus
  const handlers = yield* FiberSet.make()
  const timers = yield* FiberMap.make<string>()
  return {
    on: <T extends BusEvent["type"]>(
      definitions: ReadonlyArray<{ readonly type: T }>,
      handle: (event: EventOf<T>) => Effect.Effect<unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        const types = new Set<string>(definitions.map((definition) => definition.type))
        const subscription = yield* bus.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((event): event is EventOf<T> => types.has(event.type)),
          Stream.runForEach((event) =>
            FiberSet.run(handlers, logFailure(`handle ${event.type}`)(Effect.suspend(() => handle(event)))),
          ),
          Effect.forkScoped,
        )
      }),
    arm: (key: string, delay: Duration.Duration, effect: Effect.Effect<unknown, unknown>) =>
      FiberMap.run(
        timers,
        key,
        Effect.sleep(delay).pipe(Effect.andThen(FiberSet.run(handlers, logFailure(key)(effect)))),
      ).pipe(Effect.asVoid),
    cancel: (key: string) => FiberMap.remove(timers, key),
  }
})
