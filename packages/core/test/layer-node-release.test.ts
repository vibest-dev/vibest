import { assert, describe, it } from "@effect/vitest"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Context, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect"
import { TestClock } from "effect/testing"

class Slow extends Context.Service<Slow, true>()("test/Slow") {}

const warnings = () => {
  const seen: Array<string> = []
  const logger = Logger.make<unknown, void>((options) => {
    if (options.logLevel === "Warn") seen.push(String(options.message))
  })
  return { seen, layer: Logger.layer([logger]) }
}

const releasing = (seconds: number) =>
  LayerNode.make({
    service: Slow,
    layer: Layer.effect(
      Slow,
      Effect.addFinalizer(() => Effect.sleep(`${seconds} seconds`)).pipe(Effect.as(true as const)),
    ),
    deps: [],
  })

const closeAfter = (seconds: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(LayerNode.compile(releasing(seconds)), scope)
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* Effect.yieldNow
    yield* TestClock.adjust("6 seconds")
    return closing
  })

describe("LayerNode release tracking", () => {
  it.effect("names a layer whose release is still running after a few seconds", () => {
    const log = warnings()
    return Effect.gen(function* () {
      const closing = yield* closeAfter(30)
      assert.deepStrictEqual(log.seen, ["layer test/Slow is still releasing"])
      yield* TestClock.adjust("30 seconds")
      yield* Fiber.join(closing)
    }).pipe(Effect.provide(log.layer))
  })

  it.effect("says nothing about a layer that releases promptly", () => {
    const log = warnings()
    return Effect.gen(function* () {
      const closing = yield* closeAfter(1)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(log.seen, [])
    }).pipe(Effect.provide(log.layer))
  })
})
