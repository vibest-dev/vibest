import type { UpdateStatus } from "@vibest/protocol/schemas"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, type Effect } from "effect"

export * as UpdateCheck from "./update-check.ts"

export type Interface = Effect.Effect<UpdateStatus>

export class Service extends Context.Service<Service, Interface>()("vibest/UpdateCheck") {}

export const node = LayerNode.unbound(Service)
