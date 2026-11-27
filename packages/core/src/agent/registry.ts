import type { InvalidAgent } from "@vibest/plugin/effect"
import { UnknownAgent } from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import type { AgentDefinition, AgentsDomain, RegisteredAgent, RejectedAgent } from "../plugin/domains.ts"
import * as Registry from "../plugin/registry.ts"

export * as Agents from "./registry.ts"

const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/

export const agentProblem = (definition: AgentDefinition): string | undefined => {
  if (!AGENT_ID.test(definition.id))
    return `the id ${JSON.stringify(definition.id)} must be lowercase letters, digits and -, start with a letter and have at most 32 characters`

  if (definition.description.trim() === "") return "the description is empty"

  if (definition.system.trim() === "") return "the prompt is empty"

  if (definition.harness === undefined && (definition.provider !== undefined || definition.model !== undefined))
    return "provider and model need harness"

  return undefined
}

export const unknownAgent = (id: string, agents: Pick<AgentsDomain, "all" | "invalid">) => {
  const rejected = agents.invalid.findLast((agent) => agent.id === id)

  return new UnknownAgent({
    agent: id,
    known: agents.all.map(({ id, description }) => ({ id, description })),
    ...(rejected !== undefined && { invalid: `${rejected.source}: ${rejected.error}` }),
  })
}

interface State {
  readonly definitions: Array<RegisteredAgent>
  readonly invalid: Array<RejectedAgent>
}

const editorFor = (state: State, plugin: string) => {
  const definitions = Registry.listEditor(state.definitions)

  const reject = (agent: InvalidAgent) => {
    const masked = state.definitions.findIndex((definition) => definition.id === agent.id)

    if (masked >= 0) state.definitions.splice(masked, 1)
    state.invalid.push({ ...agent, plugin })
  }

  return {
    add: (definition: AgentDefinition) => {
      const problem = agentProblem(definition)

      if (problem === undefined) definitions.add({ ...definition, plugin })
      else reject({ id: definition.id, source: plugin, error: problem })
    },
    invalid: reject,
  }
}

export const make: Effect.Effect<AgentsDomain> = Effect.sync(() => {
  const registry = Registry.make<State, (plugin: string) => ReturnType<typeof editorFor>>({
    name: "agent",
    initial: () => ({ definitions: [], invalid: [] }),
    editor: (state) => (plugin) => editorFor(state, plugin),
  })

  return {
    get all() {
      return registry.get().definitions
    },
    get invalid() {
      return registry.get().invalid
    },
    find: (id) => (id ? registry.get().definitions.find((definition) => definition.id === id) : undefined),
    transformFor: (plugin) => (run) => registry.transform((editor) => run(editor(plugin))),
  }
})

export type Interface = AgentsDomain

export class Service extends Context.Service<Service, Interface>()("vibest/Agents") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
