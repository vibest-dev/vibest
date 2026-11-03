// The agent definitions plugins give (`context.agent.define`): what each kind of session may do. Never stored: a
// session's role names one, and what it may do is read from here on every call.
import { Agent } from "@vibest/plugin"
import { Context, Effect, Layer } from "effect"

export type AgentDefinition = Agent.AgentDefinition

export interface AgentsShape {
  /** The definition of `name`, or a worker's when nobody defined it. */
  readonly of: (name: string) => AgentDefinition
  readonly all: () => ReadonlyArray<AgentDefinition>
  /** The entry agent's definition (`entry`), the first defined; none while no plugin defines one. */
  readonly entry: () => AgentDefinition | undefined
  /** The definition a session runs as: the entry agent's for its project's entry session, otherwise its role's. */
  readonly ofSession: (row: { readonly agent: string; readonly entry: boolean }) => AgentDefinition
  readonly define: Agent.AgentRegistry["define"]
}

export class Agents extends Context.Service<Agents, AgentsShape>()("vibest/Agents") {
  static readonly make = (): AgentsShape => {
    // The plugin host defines and undefines sequentially (one supervisor consumer).
    let defined: ReadonlyArray<AgentDefinition> = []
    const of = (name: string) => defined.find((d) => d.name === name) ?? Agent.worker(name)
    const entry = () => defined.find((d) => d.entry === true)
    return {
      of,
      all: () => defined,
      entry,
      ofSession: (row) => (row.entry ? entry() : undefined) ?? of(row.agent),
      define: (definition) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            if (defined.some((d) => d.name === definition.name))
              throw new Error(`agent "${definition.name}" is already defined`)
            defined = [...defined, definition]
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (defined = defined.filter((d) => d !== definition))))
        }),
    }
  }

  static readonly layer = Layer.sync(Agents, () => Agents.make())
}
