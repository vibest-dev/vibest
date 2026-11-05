// The engine's event loop: one subscriber on the Bus, each handler in a fiber of its own, and one-shot timers by key.
// Engine-level: it knows events, not sessions or projects. Its user (Sessions) brings the handlers and their locks.
import { Cause, type Duration, Effect, FiberMap, FiberSet, Stream } from "effect"

import { Bus, type EngineEvent } from "./bus.ts"

/** Log a handler's failure; an interrupt (vibestd stopping) is not one. */
const guarded = (what: string, effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`${what}: ${Cause.pretty(cause)}`),
    ),
  )

/** Lives as long as the scope it is made in: its handler fibers and timers end with it. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus
  const handlers = yield* FiberSet.make()
  const timers = yield* FiberMap.make<string>()
  return {
    /**
     * Subscribe now, so no commit after this call is missed, then hand every event to `handle` in its own fiber. A
     * failing handler is logged and stops neither the subscription nor the other handlers.
     */
    on: (handle: (event: EngineEvent) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        const subscription = yield* bus.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) => FiberSet.run(handlers, guarded(`handle ${event.type}`, handle(event)))),
          Effect.forkScoped,
        )
      }),
    /**
     * Run `effect` once, `delay` from now, in a handler fiber. Arming `key` again replaces its pending timer; an entry
     * leaves when it fires.
     */
    arm: (key: string, delay: Duration.Duration, effect: Effect.Effect<void>) =>
      FiberMap.run(
        timers,
        key,
        Effect.sleep(delay).pipe(Effect.andThen(FiberSet.run(handlers, guarded(key, effect)))),
      ).pipe(Effect.asVoid),
  }
})
