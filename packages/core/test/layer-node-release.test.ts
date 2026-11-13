import { assert, describe, it } from "@effect/vitest"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

class Hung extends Context.Service<Hung, true>()("test/Hung") {}

const hung = (release: Effect.Effect<void>) =>
  LayerNode.make({
    service: Hung,
    layer: Layer.effect(Hung, Effect.addFinalizer(() => release).pipe(Effect.as(true as const))),
    deps: [],
  })

const closeAndWait = (release: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const reports: Array<ReadonlyArray<string>> = []
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(
      LayerNode.compile(hung(release), {
        releaseDeadline: {
          after: "10 seconds",
          expired: (releasing) => Effect.sync(() => void reports.push(releasing)),
        },
      }),
      scope,
    )
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* Effect.yieldNow
    yield* TestClock.adjust("11 seconds")
    return { reports, closing }
  })

describe("LayerNode release deadline", () => {
  it.effect("reports the layer whose release has not finished when the deadline passes", () =>
    Effect.gen(function* () {
      const unblock = yield* Deferred.make<void>()
      const { reports, closing } = yield* closeAndWait(Deferred.await(unblock))
      assert.deepStrictEqual(reports, [["test/Hung"]])
      yield* Deferred.succeed(unblock, undefined)
      yield* Fiber.join(closing)
    }),
  )

  it.effect("reports nothing when every layer releases in time", () =>
    Effect.gen(function* () {
      const { reports, closing } = yield* closeAndWait(Effect.void)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(reports, [])
    }),
  )
})
