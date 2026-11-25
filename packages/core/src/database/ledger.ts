import { LayerNode } from "@vibest/util/layer-node"
import { Layer } from "effect"
import type { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { PlatformNode } from "../effect/platform.ts"

export * as Ledger from "./ledger.ts"

export type ProjectorLayer = Layer.Layer<never, never, Bus.Service | SqlClient.SqlClient>

export const projectorsOf = (layers: readonly [ProjectorLayer, ...ReadonlyArray<ProjectorLayer>]) => {
  const [first, ...rest] = layers
  const layer = rest.reduce<ProjectorLayer>((acc, next) => Layer.merge(acc, next), first)

  const node = LayerNode.make({
    name: "vibest/Projectors",
    layer,
    deps: [Bus.node, PlatformNode.sqlClient],
  })

  const replay = layer.pipe(Layer.provideMerge(Bus.layer))

  return { layer, node, replay } as const
}
