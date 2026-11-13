import { assert, describe, it } from "@effect/vitest"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Context, Effect, Layer } from "effect"

class Probe extends Context.Service<Probe, true>()("test/Probe") {}

describe("LayerNode.unbound", () => {
  it("an omitted host binding is rejected before any layer is acquired", () => {
    let acquired = false
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
    assert.throws(
      () => LayerNode.compile(LayerNode.group([probe, PlatformNode.sqlClient])),
      "Unbound layer node: vibest/SqlClientLayer",
    )
    assert.isFalse(acquired)
  })
})
