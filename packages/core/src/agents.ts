import { UnknownAgent } from "@vibest/schema/session"
import { Context, Effect, Layer } from "effect"

import { LayerNode } from "./effect/layer-node.ts"
import type { AgentDefinition, AgentsShape } from "./plugin/host.ts"
import * as Registry from "./plugin/registry.ts"

export * as Agents from "./agents.ts"

export const unknownAgent = (id: string, loaded: ReadonlyArray<AgentDefinition>) =>
  new UnknownAgent({
    agent: id,
    known: loaded.map(({ id, description }) => ({ id, description })),
  })

export const make: Effect.Effect<AgentsShape> = Effect.sync(() => {
  const registry = Registry.definitions<AgentDefinition>("agent")
  return {
    get all() {
      return registry.get()
    },
    find: (id) => (id ? registry.get().find((definition) => definition.id === id) : undefined),
    transform: registry.transform,
  }
})

export type Interface = AgentsShape

export class Service extends Context.Service<Service, Interface>()("vibest/Agents") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
