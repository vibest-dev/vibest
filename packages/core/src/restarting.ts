import { Context, Effect, Layer } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

const make = Effect.sync(() => {
  const ids = new Set<string>()
  return {
    has: (id: string) => ids.has(id),
    mark: (id: string) =>
      Effect.sync(() => {
        ids.add(id)
      }),
    clear: (id: string) =>
      Effect.sync(() => {
        ids.delete(id)
      }),
  }
})

export class Restarting extends Context.Service<Restarting, Effect.Success<typeof make>>()("vibest/Restarting") {
  static readonly layer = Layer.effect(Restarting, make)

  static readonly node = LayerNode.make({ service: Restarting, layer: Restarting.layer, deps: [] })
}
