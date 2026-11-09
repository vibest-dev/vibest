import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import * as Leases from "@vibest/core/leases"
import { Duration, Effect, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"

const settled = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const leases = Effect.gen(function* () {
  const expired = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([])
  const onExpire = (ids: ReadonlyArray<number>) => Ref.update(expired, (all) => [...all, ids])
  return { leases: yield* Leases.make, expired: Ref.get(expired), onExpire }
})

const test = (name: string, program: Effect.Effect<void, never, Bus | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.scoped, Effect.provide(Bus.layer)))

describe("leases", () => {
  test(
    "a lease with a ttl ends on its own at the ttl, once",
    Effect.gen(function* () {
      const { leases: l, expired, onExpire } = yield* leases
      yield* l.hold("p", [1, 2], Duration.seconds(30), onExpire)
      yield* TestClock.adjust("29 seconds")
      yield* settled
      assert.deepStrictEqual(yield* expired, [])
      assert.deepStrictEqual(l.held("p"), [1, 2])
      yield* TestClock.adjust("1 second")
      yield* settled
      assert.deepStrictEqual(
        [...(yield* expired)].map((ids) => [...ids]),
        [[1], [2]],
      )
      assert.deepStrictEqual(l.held("p"), [])
      yield* TestClock.adjust("1 hour")
      yield* settled
      assert.lengthOf(yield* expired, 2)
    }),
  )

  test(
    "a settled lease does not expire",
    Effect.gen(function* () {
      const { leases: l, expired, onExpire } = yield* leases
      yield* l.hold("p", [1], Duration.seconds(30), onExpire)
      yield* l.settle([1])
      yield* TestClock.adjust("1 minute")
      yield* settled
      assert.deepStrictEqual(yield* expired, [])
      assert.deepStrictEqual(l.held("p"), [])
    }),
  )

  test(
    "expireAll ends one recipient's leases in one call; another's stay",
    Effect.gen(function* () {
      const { leases: l, expired, onExpire } = yield* leases
      yield* l.hold("p", [1, 2], undefined, onExpire)
      yield* l.hold("q", [3], undefined, onExpire)
      yield* l.expireAll("p")
      assert.deepStrictEqual(
        [...(yield* expired)].map((ids) => [...ids]),
        [[1, 2]],
      )
      assert.deepStrictEqual(l.held("p"), [])
      assert.deepStrictEqual(l.held("q"), [3])
      yield* l.expireAll("p")
      assert.lengthOf(yield* expired, 1)
    }),
  )
})
