import { Layer } from "effect"

import { Bus } from "../bus.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as Project from "../project/projector.ts"
import * as Remote from "../remote/projector.ts"
import * as Session from "../session/projector.ts"

export const layer = Layer.mergeAll(Project.layer, Session.layer, Remote.layer)

export const node = LayerNode.make({ name: "vibest/Projectors", layer, deps: [Bus.node] })

export const replay = layer.pipe(Layer.provideMerge(Bus.layer))
