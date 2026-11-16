import { LayerNode } from "@vibest/core/effect/layer-node"
import type { UpdateStatus } from "@vibest/protocol/rpc"
import { Context, type Effect } from "effect"

export * as UpdateCheck from "./update-check.ts"

export type Interface = Effect.Effect<UpdateStatus>

export class Service extends Context.Service<Service, Interface>()("vibest/UpdateCheck") {}

export const node = LayerNode.unbound(Service)
