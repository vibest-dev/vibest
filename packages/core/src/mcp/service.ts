import type { Mcp } from "@vibest/schema/mcp"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, type Schema, type Stream } from "effect"

import type { Bus } from "../bus.ts"

export * as McpService from "./service.ts"

export interface Interface {
  readonly awaitStartup: () => Effect.Effect<void>
  readonly list: (directory?: string) => Effect.Effect<ReadonlyArray<Mcp.ServerInfo>>
  readonly add: (server: string, config: Mcp.ServerConfig) => Effect.Effect<Mcp.ServerInfo, Mcp.ConfigError>
  readonly remove: (server: string) => Effect.Effect<void, Mcp.NotFoundError>
  readonly connect: (server: string, directory?: string) => Effect.Effect<Mcp.ServerInfo, Mcp.NotFoundError>
  readonly disconnect: (server: string) => Effect.Effect<void, Mcp.NotFoundError>
  readonly tools: (server?: string, directory?: string) => Effect.Effect<ReadonlyArray<Mcp.ToolInfo>, Mcp.NotFoundError>
  readonly search: (query: string, directory?: string) => Effect.Effect<ReadonlyArray<Mcp.ToolInfo>>
  readonly describe: (
    server: string,
    tool: string,
    directory?: string,
  ) => Effect.Effect<Mcp.ToolInfo, Mcp.NotFoundError | Mcp.ToolNotFoundError>
  readonly call: (input: {
    readonly server: string
    readonly tool: string
    readonly args?: Schema.JsonObject | undefined
    readonly directory?: string | undefined
  }) => Effect.Effect<Mcp.CallResult, Mcp.NotFoundError | Mcp.ToolCallError | Mcp.AuthError>
  readonly events: (
    server: string,
    directory?: string,
  ) => Effect.Effect<ReadonlyArray<Mcp.EventType>, Mcp.NotFoundError | Mcp.ToolCallError>
  readonly eventStream: (input: {
    readonly server: string
    readonly name: string
    readonly arguments?: Schema.JsonObject | undefined
    readonly cursor?: string | null | undefined
    readonly maxAgeMs?: number | undefined
    readonly directory?: string | undefined
  }) => Stream.Stream<Mcp.EventMessage, Mcp.NotFoundError | Mcp.ToolCallError>
  readonly skills: (
    server: string,
    directory?: string,
  ) => Effect.Effect<ReadonlyArray<Mcp.SkillEntry>, Mcp.NotFoundError | Mcp.ToolCallError>
  readonly read: (input: {
    readonly server: string
    readonly uri: string
    readonly directory?: string | undefined
  }) => Effect.Effect<Mcp.ReadResourceResult, Mcp.NotFoundError | Mcp.ToolCallError | Mcp.AuthError>
  readonly authStart: (server: string) => Effect.Effect<Mcp.AuthStartResult, Mcp.NotFoundError | Mcp.AuthError>
  readonly authComplete: (
    server: string,
    redirectUrlOrCode: string,
    state?: string,
  ) => Effect.Effect<Mcp.AuthCompleteResult, Mcp.NotFoundError | Mcp.AuthError>
  readonly authSetToken: (
    server: string,
    input: {
      readonly accessToken: string
      readonly refreshToken?: string | undefined
      readonly expiresAt?: number | undefined
      readonly scope?: string | undefined
    },
  ) => Effect.Effect<Mcp.AuthCompleteResult, Mcp.NotFoundError | Mcp.AuthError>
  readonly authLogout: (server: string) => Effect.Effect<void, Mcp.NotFoundError | Mcp.AuthError>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Mcp") {}

export const node = LayerNode.unbound<Service, Interface, LayerNode.Error<typeof Bus.node>>(Service)
