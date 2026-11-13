import { LayerNode } from "@vibest/core/effect/layer-node"
import type { UpdateStatus } from "@vibest/protocol/rpc"
import { Context, type Effect } from "effect"

export class UpdateCheck extends Context.Service<UpdateCheck, Effect.Effect<UpdateStatus>>()("vibest/UpdateCheck") {
  static readonly node = LayerNode.unbound(UpdateCheck)
}

export const NOT_CHECKED: UpdateStatus = { checked: null, latest: null, checking: false }
