import { assert, describe, it } from "@effect/vitest"
import { RunCoordinator } from "@vibest/core/session/run-coordinator"
import { Deferred, Effect } from "effect"

describe("RunCoordinator", () => {
  it.effect("50 wakes during a drain become one more drain carrying all of them; another key drains meanwhile", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const drains: Array<{ key: string; wake: ReadonlyArray<number> }> = []
      const coordinator = yield* RunCoordinator.make<string, ReadonlyArray<number>>({
        drain: (key, wake) =>
          Effect.gen(function* () {
            drains.push({ key, wake })
            if (key !== "a") return
            if (drains.filter((d) => d.key === "a").length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            } else yield* Deferred.succeed(done, undefined)
          }),
        merge: (pending, next) => [...pending, ...next],
      })
      yield* coordinator.wake("a", [0])
      yield* Deferred.await(started)
      for (let i = 1; i <= 50; i++) yield* coordinator.wake("a", [i])
      yield* coordinator.wake("b", [99])
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.deepStrictEqual(drains, [
        { key: "a", wake: [0] },
        { key: "b", wake: [99] },
      ])
      yield* Deferred.succeed(gate, undefined)
      yield* Deferred.await(done)
      yield* Effect.yieldNow
      assert.deepStrictEqual(
        drains.filter((d) => d.key === "a").map((d) => d.wake),
        [[0], Array.from({ length: 50 }, (_, i) => i + 1)],
      )
    }).pipe(Effect.scoped),
  )
})
