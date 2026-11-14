import { Context } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export * as App from "./app.ts"

export interface Interface {
  readonly version: string
}

export class Service extends Context.Service<Service, Interface>()("vibest/App") {}

export const node = LayerNode.unbound(Service)
