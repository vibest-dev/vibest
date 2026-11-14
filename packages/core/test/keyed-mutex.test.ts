import { assert, describe, it } from "@effect/vitest"
import { KeyedMutex } from "@vibest/core/effect/keyed-mutex"
import { Deferred, Effect, Fiber, Scheduler } from "effect"

import { interruptOnceReady } from "./lib/interrupt-at.ts"

describe("KeyedMutex", () => {
  it.effect("one holder per key; the entry goes once released with nobody waiting", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedMutex.make<number>()
      const order: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        locks.withLock(1)(
          Effect.sync(() => order.push("first in")).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.sync(() => order.push("first out"))),
          ),
        ),
      )
      yield* Effect.yieldNow
      const second = yield* Effect.forkChild(locks.withLock(1)(Effect.sync(() => order.push("second"))))
      yield* locks.withLock(2)(Effect.sync(() => order.push("other key")))
      yield* Effect.yieldNow
      assert.strictEqual(yield* locks.size, 1)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.deepStrictEqual(order, ["first in", "other key", "first out", "second"])
      assert.strictEqual(yield* locks.size, 0)
    }),
  )

  it.effect("a waiter interrupted while it waits and a failed holder leave no entry", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedMutex.make<string>()
      const holding = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        locks.withLock("a")(Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(gate)))),
      )
      yield* Deferred.await(holding)
      const waiter = yield* Effect.forkChild(locks.withLock("a")(Effect.void))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiter)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(holder)
      assert.strictEqual(yield* locks.size, 0)
      yield* Effect.flip(locks.withLock("a")(Effect.fail("boom")))
      assert.strictEqual(yield* locks.size, 0)
    }),
  )

  it.effect("a holder interrupted after it took the lock releases it", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedMutex.make<string>()
      const holding = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        locks.withLock("a")(Deferred.succeed(holding, undefined).pipe(Effect.andThen(Effect.never))),
      )
      yield* Deferred.await(holding)
      yield* Fiber.interrupt(holder)
      assert.strictEqual(yield* locks.size, 0)
      yield* Effect.exit(locks.withLock("a")(Effect.interrupt))
      assert.strictEqual(yield* locks.size, 0)
    }),
  )
})

describe("KeyedMutex registration", () => {
  it.effect("an interrupt right after the key was registered leaves no entry", () =>
    Effect.gen(function* () {
      const locks = yield* KeyedMutex.make<string>()
      const registered = () => Effect.runSync(locks.size) === 1
      const fiber = yield* Effect.forkChild(
        locks
          .withLock("a")(Effect.never)
          .pipe(Effect.provideService(Scheduler.Scheduler, interruptOnceReady(registered))),
      )
      yield* Fiber.await(fiber)
      assert.strictEqual(yield* locks.size, 0)
    }),
  )
})
