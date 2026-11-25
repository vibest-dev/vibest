import { LayerNode } from "@vibest/util/layer-node"
import { Context } from "effect"

export * as App from "./app.ts"

export interface Interface {
  readonly version: string
}

export class Service extends Context.Service<Service, Interface>()("vibest/App") {}

export const node = LayerNode.unbound(Service)
