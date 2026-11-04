// Agent definitions: what a kind of session may do. The engine knows one kind of session; its `role` names a
// definition a plugin gives with `context.agent.define` (@vibest/plugin-coordinator gives the main agent and the worker).
import type { Effect, Scope } from "effect"

export interface AgentDefinition {
  /** The name `vibest run --agent <name>` and the session's role use. */
  readonly name: string
  /** The guard's tier: `inspect` reads and runs vibest but edits nothing (a main agent); `full` works in its worktree. */
  readonly tools: "inspect" | "full"
  readonly can: {
    /** Starts sessions of its own (`vibest run`); they report to it and are placed beside it. */
    readonly spawn: boolean
    /**
     * Whom it may send to, interrupt, peek and remove: `report-only` none (it only reports), `children` the sessions it
     * started and theirs, `group` the sessions of its project it shares a group with (`context.group`), `project` any
     * session of its project.
     */
    readonly message: "report-only" | "children" | "group" | "project"
  }
  /**
   * More rules for a session of this agent, after vibest's own; for the entry agent, the whole of its rules (the project's
   * instructions and memory follow).
   */
  readonly rules?: string
  /** The agent `vibest` starts at a project's root, one per project; the first definition with it set is used. */
  readonly entry?: boolean
  /** The skills of vibest's own (`delegate`, `pipeline`) its sessions get, where the harness can choose per session. */
  readonly skills?: ReadonlyArray<string>
}

/** What a session of an agent nobody defined may do: a worker. */
export const worker = (name: string): AgentDefinition => ({
  name,
  tools: "full",
  can: { spawn: false, message: "report-only" },
})

export interface AgentRegistry {
  /** Define an agent for the plugin's lifetime; a name already defined is a setup failure. */
  readonly define: (definition: AgentDefinition) => Effect.Effect<void, never, Scope.Scope>
}
