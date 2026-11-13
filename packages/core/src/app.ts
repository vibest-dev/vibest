import { Context } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export class App extends Context.Service<App, { readonly version: string }>()("vibest/App") {
  static readonly node = LayerNode.unbound(App)
}
