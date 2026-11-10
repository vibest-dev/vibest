import { Cause, type Duration, Effect, FiberMap, FiberSet, Stream } from "effect"

import { Bus, type EngineEvent } from "./bus.ts"

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
    on: (handle: (event: EngineEvent) => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const subscription = yield* bus.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) => FiberSet.run(handlers, logFailure(`handle ${event.type}`)(handle(event)))),
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
