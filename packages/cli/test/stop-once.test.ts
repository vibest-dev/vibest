import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Drain } from "@vibest/core/drain"
import { DRAIN_TIMEOUT, stopOnce } from "@vibest/server/stop"
import { Deferred, Duration, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

const drainLayer = Drain.layer.pipe(Layer.provideMerge(Bus.layer))

const stopper = Effect.gen(function* () {
  const drain = yield* Drain
  const bus = yield* Bus
  const shutdown = yield* Deferred.make<void>()
  return { drain, shutdown, stop: stopOnce({ drain, bus, deliveringInbox: Effect.succeed([]), shutdown }) }
})

describe("stopOnce: the takeover (the new vibestd of a handoff) starts only once the stop is certain", () => {
  it.effect(
    "an execution end arriving while the new vibestd starts is refused, and the handoff completes; it does not fail after the start",
    () =>
      Effect.gen(function* () {
        const { drain, shutdown, stop } = yield* stopper
        const lateExecutionEnd = yield* Ref.make<"admitted" | "refused" | "not tried">("not tried")
        const takeOver = Effect.gen(function* () {
          const leave = yield* drain.admit("ExecutionEnd", true)
          yield* Ref.set(lateExecutionEnd, leave === undefined ? "refused" : "admitted")
          if (leave !== undefined) yield* leave
        })
        assert.deepStrictEqual(yield* stop("instance", "Daemon.Handoff", takeOver), { instance: "instance" })
        assert.strictEqual(yield* Ref.get(lateExecutionEnd), "refused")
        assert.isTrue(yield* Deferred.isDone(shutdown))
        assert.strictEqual(yield* drain.phase, "accepted")
      }).pipe(Effect.provide(drainLayer)),
  )

  it.effect("a settlement held through the drain refuses the handoff before anything is started, and reopens", () =>
    Effect.gen(function* () {
      const { drain, shutdown, stop } = yield* stopper
      const leave = (yield* drain.admit("ExecutionEnd", true))!
      const started = yield* Ref.make(false)
      const fiber = yield* Effect.forkChild(
        stop("instance", "Daemon.Handoff", Ref.set(started, true)).pipe(Effect.flip),
      )
      yield* TestClock.adjust(Duration.sum(DRAIN_TIMEOUT, Duration.seconds(1)))
      const refused = yield* Fiber.join(fiber)
      yield* leave
      assert.strictEqual(refused._tag, "DaemonBusy")
      assert.isFalse(yield* Ref.get(started))
      assert.isFalse(yield* Deferred.isDone(shutdown))
      assert.strictEqual(yield* drain.phase, "open")
    }).pipe(Effect.provide(drainLayer)),
  )

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

  it.effect("interrupted while it waits for the drain: nothing started, and vibestd reopens", () =>
    Effect.gen(function* () {
      const { drain, shutdown, stop } = yield* stopper
      const leave = (yield* drain.admit("ExecutionEnd", true))!
      const started = yield* Ref.make(false)
      const fiber = yield* Effect.forkChild(stop("instance", "Daemon.Handoff", Ref.set(started, true)))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      yield* leave
      assert.isFalse(yield* Ref.get(started))
      assert.isFalse(yield* Deferred.isDone(shutdown))
      assert.strictEqual(yield* drain.phase, "open")
    }).pipe(Effect.provide(drainLayer)),
  )
})
