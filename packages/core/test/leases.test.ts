import { assert, describe } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import * as Leases from "@vibest/core/leases"
import { Duration, Effect, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"

import { testEffect } from "./lib/effect.ts"
import { compile } from "./lib/layers.ts"

const settled = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const leases = Effect.gen(function* () {
  const expired = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([])
  const onExpire = (ids: ReadonlyArray<number>) => Ref.update(expired, (all) => [...all, ids])
  return { leases: yield* Leases.make, expired: Ref.get(expired), onExpire }
})

const it = testEffect(compile(Bus.node))

const test = (name: string, program: Effect.Effect<void, never, Bus | Scope.Scope>) =>
  it(name, () => program.pipe(Effect.scoped))

describe("leases", () => {
  test(
    "a lease with a ttl ends on its own at the ttl, once",
    Effect.gen(function* () {
      const { leases: l, expired, onExpire } = yield* leases
      yield* l.hold("p", "s", [1, 2], Duration.seconds(30), onExpire)
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
      yield* l.hold("p", "s", [1], Duration.seconds(30), onExpire)
      yield* l.settle("s", [1])
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
      yield* l.hold("p", "s", [1, 2], undefined, onExpire)
      yield* l.hold("q", "t", [3], undefined, onExpire)
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

  test(
    "two sessions that share an inbox id hold, settle and expire their leases apart",
    Effect.gen(function* () {
      const { leases: l, expired, onExpire } = yield* leases
      yield* l.hold("p", "s", [3], Duration.seconds(30), onExpire)
      yield* l.hold("q", "t", [3], Duration.seconds(60), onExpire)
      assert.deepStrictEqual(l.held("p"), [3])
      assert.deepStrictEqual(l.held("q"), [3])
      yield* l.settle("t", [3])
      assert.deepStrictEqual(l.held("p"), [3], "settling t's row 3 leaves s's row 3 leased")
      assert.deepStrictEqual(l.held("q"), [])
      yield* TestClock.adjust("30 seconds")
      yield* settled
      assert.deepStrictEqual(
        [...(yield* expired)].map((ids) => [...ids]),
        [[3]],
      )
      assert.deepStrictEqual(l.held("p"), [])
    }),
  )
})
