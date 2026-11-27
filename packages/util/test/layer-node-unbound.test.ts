import { assert, describe, it } from "@effect/vitest"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

class Missing extends Context.Service<Missing, true>()("test/Missing") {}

class Probe extends Context.Service<Probe, true>()("test/Probe") {}

describe("LayerNode.unbound", () => {
  it("an omitted host binding is rejected before any layer is acquired", () => {
    let acquired = false

    const missing = LayerNode.unbound(Missing)

    const probe = LayerNode.make({
      service: Probe,
      layer: Layer.effect(
        Probe,
        Effect.sync(() => {
          acquired = true

          return true as const
        }),
      ),
      deps: [],
    })

    assert.throws(() => LayerNode.compile(LayerNode.group([probe, missing])), "Unbound layer node: test/Missing")
    assert.isFalse(acquired)
  })
})
