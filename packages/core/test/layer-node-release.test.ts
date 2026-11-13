import { assert, describe, it } from "@effect/vitest"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"

class Hung extends Context.Service<Hung, true>()("test/Hung") {}

const hung = (release: Effect.Effect<void>) =>
  LayerNode.make({
    service: Hung,
    layer: Layer.effect(Hung, Effect.addFinalizer(() => release).pipe(Effect.as(true as const))),
    deps: [],
  })

const closeAfterBuilding = (release: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const releases = new LayerNode.Releases()
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(LayerNode.compile(hung(release), { releases }), scope)
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* Effect.yieldNow
    return { releases, closing }
  })

describe("LayerNode release tracking", () => {
  it.effect("names a layer whose release has not finished, with how long it has been releasing", () =>
    Effect.gen(function* () {
      const unblock = yield* Deferred.make<void>()
      const { releases, closing } = yield* closeAfterBuilding(Deferred.await(unblock))
      const pending = releases.pending(Date.now() + 5_000)
      assert.deepStrictEqual(
        pending.map((item) => item.name),
        ["test/Hung"],
      )
      assert.isAtLeast(pending[0]!.ms, 5_000)
      yield* Deferred.succeed(unblock, undefined)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(releases.pending(), [])
    }),
  )

  it.effect("reports nothing while the graph is running", () =>
    Effect.gen(function* () {
      const releases = new LayerNode.Releases()
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(LayerNode.compile(hung(Effect.void), { releases }), scope)
      assert.deepStrictEqual(releases.pending(), [])
      yield* Scope.close(scope, Exit.void)
    }),
  )
})
