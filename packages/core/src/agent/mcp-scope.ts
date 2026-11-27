import { Effect, Option } from "effect"

import type { SessionStore } from "../session/store.ts"
import type { Agents } from "./registry.ts"

export interface AgentMcpScope {
  readonly agent: string
  readonly allowed: ReadonlySet<string>
}

export const mcpDisallowedMessage = (agent: string, server: string) =>
  `agent "${agent}" does not allow MCP server "${server}"`

export const sessionMcpScope = (
  sessionStore: SessionStore.Interface,
  agents: Agents.Interface,
  sessionId: string,
): Effect.Effect<Option.Option<AgentMcpScope>> =>
  Effect.map(sessionStore.getSession(sessionId), (session) => {
    if (session === undefined) return Option.none()
    const definition = agents.find(session.agent)

    if (definition?.mcpServers === undefined) return Option.none()

    return Option.some({ agent: session.agent, allowed: new Set(definition.mcpServers) })
  })
