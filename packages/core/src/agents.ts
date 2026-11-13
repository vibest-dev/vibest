import { UnknownAgent } from "@vibest/schema/session"
import { Context, Effect, Layer } from "effect"

import { LayerNode } from "./effect/layer-node.ts"
import type { AgentDefinition, AgentsShape } from "./plugin/host.ts"
import * as Registry from "./plugin/registry.ts"
export type { AgentDefinition }

export const unknownAgent = (id: string, loaded: ReadonlyArray<AgentDefinition>) =>
  new UnknownAgent({
    agent: id,
    known: loaded.map(({ id, description }) => ({ id, description })),
  })

export const makeAgents: Effect.Effect<AgentsShape> = Effect.sync(() => {
  const registry = Registry.definitions<AgentDefinition>("agent")
  return {
    get all() {
      return registry.get()
    },
    find: (id) => (id ? registry.get().find((definition) => definition.id === id) : undefined),
    transform: registry.transform,
  }
})

export class Agents extends Context.Service<Agents, AgentsShape>()("vibest/Agents") {
  static readonly layer = Layer.effect(Agents, makeAgents)

  static readonly node = LayerNode.make({ service: Agents, layer: Agents.layer, deps: [] })
}
