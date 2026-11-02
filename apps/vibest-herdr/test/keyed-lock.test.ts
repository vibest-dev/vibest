import { assert, describe, it } from "@effect/vitest"
import { keyedLock } from "@vibest/core/keyed-lock"
import { Deferred, Effect, Fiber } from "effect"

describe("keyedLock", () => {
  it.effect("one holder per key; the entry goes once released with nobody waiting", () =>
    Effect.gen(function* () {
      const locks = keyedLock<number>()
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
      // Another key does not wait.
      yield* locks.withLock(2)(Effect.sync(() => order.push("other key")))
      yield* Effect.yieldNow
      assert.strictEqual(locks.size(), 1)
      assert.isTrue(locks.busy(1))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.deepStrictEqual(order, ["first in", "other key", "first out", "second"])
      assert.strictEqual(locks.size(), 0)
    }),
  )

  it.effect("an interrupted waiter, a failed holder and a take/release pair leave no entry", () =>
    Effect.gen(function* () {
      const locks = keyedLock<string>()
      const release = yield* locks.take("a")
      const waiter = yield* Effect.forkChild(locks.withLock("a")(Effect.void))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiter)
      yield* release
      assert.strictEqual(locks.size(), 0)
      yield* Effect.flip(locks.withLock("a")(Effect.fail("boom")))
      assert.strictEqual(locks.size(), 0)
    }),
  )
})
