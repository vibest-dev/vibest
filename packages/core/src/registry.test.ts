import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"

import * as Registry from "./registry.ts"

type Item = { readonly id: string; readonly value: number }

const counted = () => {
  const seen: Array<ReadonlyArray<Item>> = []
  const registry = Registry.definitions<Item>("items", (list) => Effect.sync(() => void seen.push(list)))
  return { registry, seen }
}

describe("registry", () => {
  it.effect("applies transforms in registration order, each seeing what earlier ones built", () =>
    Effect.gen(function* () {
      const { registry } = counted()
      yield* registry.transform((e) => e.add({ id: "a", value: 1 }))
      yield* registry.transform((e) => e.add({ id: "b", value: 2 }))
      yield* registry.transform((e) => e.update("a", (d) => void (d.value = d.value + 10)))
      assert.deepStrictEqual(registry.get(), [
        { id: "a", value: 11 },
        { id: "b", value: 2 },
      ])
    }).pipe(Effect.scoped),
  )

  it.effect("a later add with the same id replaces the definition in place", () =>
    Effect.gen(function* () {
      const { registry } = counted()
      yield* registry.transform((e) => e.add({ id: "a", value: 1 }))
      yield* registry.transform((e) => e.add({ id: "b", value: 2 }))
      yield* registry.transform((e) => e.add({ id: "a", value: 3 }))
      assert.deepStrictEqual(
        registry.get().map((d) => [d.id, d.value]),
        [
          ["a", 3],
          ["b", 2],
        ],
      )
    }).pipe(Effect.scoped),
  )

  it.effect("dispose rebuilds without the transform, a second dispose is a no-op, and values read earlier stay", () =>
    Effect.gen(function* () {
      const { registry, seen } = counted()
      yield* registry.transform((e) => e.add({ id: "a", value: 1 }))
      const b = yield* registry.transform((e) => e.add({ id: "b", value: 2 }))
      const before = registry.get()
      yield* b.dispose
      yield* b.dispose
      assert.deepStrictEqual(
        registry.get().map((d) => d.id),
        ["a"],
      )
      assert.deepStrictEqual(
        before.map((d) => d.id),
        ["a", "b"],
      )
      assert.strictEqual(seen.length, 3)
    }).pipe(Effect.scoped),
  )

  it.effect("closing the owning scope removes its transforms", () =>
    Effect.gen(function* () {
      const { registry } = counted()
      const scope = yield* Scope.make()
      yield* registry.transform((e) => e.add({ id: "a", value: 1 })).pipe(Scope.provide(scope))
      assert.strictEqual(registry.get().length, 1)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(registry.get().length, 0)
    }),
  )

  it.effect("a batch rebuilds and notifies once, with the committed value", () =>
    Effect.gen(function* () {
      const { registry, seen } = counted()
      yield* Registry.batch(
        Effect.gen(function* () {
          yield* registry.transform((e) => e.add({ id: "a", value: 1 }))
          yield* registry.transform((e) => e.add({ id: "b", value: 2 }))
          assert.strictEqual(seen.length, 0)
        }),
      )
      assert.strictEqual(seen.length, 1)
      assert.deepStrictEqual(
        seen[0]!.map((d) => d.id),
        ["a", "b"],
      )
    }).pipe(Effect.scoped),
  )

  it.effect("a throwing transform removes every registration of its group and reports it", () =>
    Effect.gen(function* () {
      const { registry } = counted()
      const reported: Array<Registry.Failure> = []
      let refresh: Effect.Effect<void> = Effect.void
      yield* registry.transform((e) => e.add({ id: "builtin", value: 0 }))
      yield* Effect.gen(function* () {
        yield* registry.transform((e) => e.add({ id: "mine", value: 1 }))
        yield* registry.transform(() => {
          throw new Error("broken")
        })
      }).pipe(
        Registry.group((failure, after) => {
          reported.push(failure)
          refresh = after
        }),
      )
      assert.deepStrictEqual(
        registry.get().map((d) => d.id),
        ["builtin"],
      )
      assert.strictEqual(reported[0]?.state, "items")
      yield* refresh
    }).pipe(Effect.scoped),
  )

  it.effect("a transform may not reload or register on its own registry", () =>
    Effect.gen(function* () {
      const { registry } = counted()
      const exit = yield* registry
        .transform(() => {
          Effect.runSync(registry.reload())
        })
        .pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.throws(() => registry.get(), /reload inside a transform/)
    }).pipe(Effect.scoped),
  )

  it.effect("shutdown closes the registry: later changes neither rebuild nor notify", () =>
    Effect.gen(function* () {
      const { registry, seen } = counted()
      yield* registry.transform((e) => e.add({ id: "a", value: 1 }))
      const count = seen.length
      yield* Registry.shutdown(registry.reload())
      yield* registry.reload()
      assert.strictEqual(seen.length, count)
    }).pipe(Effect.scoped),
  )
})
