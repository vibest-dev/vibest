import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Drain } from "@vibest/core/drain"
import { stopOnce } from "@vibest/server/stop"
import { Deferred, Effect, Fiber, Layer } from "effect"

import { memoryBus } from "./unit-helpers.ts"

const drainLayer = Drain.layer.pipe(Layer.provideMerge(memoryBus))

const stopper = Effect.gen(function* () {
  const drain = yield* Drain
  const bus = yield* Bus
  const shutdown = yield* Deferred.make<void>()
  return { drain, shutdown, stop: stopOnce({ drain, bus, deliveringInbox: Effect.succeed([]), shutdown }) }
})

describe("stopOnce: the takeover (the new vibestd of a handoff) starts only once the stop is certain", () => {
  it.effect("interrupted during the takeover: the new vibestd still starts, and the stop stays accepted", () =>
    Effect.gen(function* () {
      const { drain, shutdown, stop } = yield* stopper
      const takingOver = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const takeOver = Deferred.succeed(takingOver, undefined).pipe(Effect.andThen(Deferred.await(started)))
      const fiber = yield* Effect.forkChild(stop("instance", "Daemon.Handoff", takeOver))
      yield* Deferred.await(takingOver)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      yield* Deferred.succeed(started, undefined)
      yield* Fiber.join(interrupting)
      assert.isTrue(yield* Deferred.isDone(shutdown))
      assert.strictEqual(yield* drain.phase, "accepted")
      assert.isUndefined(yield* drain.admit("ExecutionEnd", true))
    }).pipe(Effect.provide(drainLayer)),
  )
})
