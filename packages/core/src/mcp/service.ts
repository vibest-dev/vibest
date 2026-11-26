import { Layout } from "@vibest/schema/layout"
import type { Mcp } from "@vibest/schema/mcp"
import { McpEvent } from "@vibest/schema/mcp-event"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer, type Schema, type Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"

import { Bus } from "../bus.ts"
import { PlatformNode } from "../effect/platform.ts"

export * as McpService from "./service.ts"

export interface Interface {
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
    readonly maxBytes?: number | undefined
    readonly scratchpadDir?: string | undefined
  }) => Effect.Effect<Mcp.CallResult, Mcp.NotFoundError | Mcp.ToolCallError | Mcp.AuthError>
  readonly events: (
    server: string,
    directory?: string,
  ) => Effect.Effect<ReadonlyArray<Mcp.EventType>, Mcp.NotFoundError | Mcp.ToolCallError>
  readonly skills: (
    server: string,
    directory?: string,
  ) => Effect.Effect<ReadonlyArray<Mcp.SkillEntry>, Mcp.NotFoundError | Mcp.ToolCallError>
  readonly read: (input: {
    readonly server: string
    readonly uri: string
    readonly directory?: string | undefined
    readonly maxBytes?: number | undefined
    readonly scratchpadDir?: string | undefined
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

export interface HostOptions {
  readonly vibestHome: string
  readonly events?:
    | {
        readonly onStatusChanged?: ((server: Mcp.ServerName, status: Mcp.Status) => Effect.Effect<void>) | undefined
        readonly onToolsChanged?: ((server: Mcp.ServerName) => Effect.Effect<void>) | undefined
        readonly onResourcesChanged?: ((server: Mcp.ServerName) => Effect.Effect<void>) | undefined
      }
    | undefined
}

export type HostFactory = (
  options: HostOptions,
) => Effect.Effect<Interface, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>

export class Host extends Context.Service<Host, HostFactory>()("vibest/McpHost") {}

export const hostNode = LayerNode.unbound(Host)

export class Service extends Context.Service<Service, Interface>()("vibest/Mcp") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const layout = yield* Layout
    const bus = yield* Bus.Service
    const makeHost = yield* Host

    return yield* makeHost({
      vibestHome: layout.home,
      events: {
        onStatusChanged: (server, status) => bus.publish(McpEvent.StatusChanged, { server, status }),
        onToolsChanged: (server) => bus.publish(McpEvent.ToolsChanged, { server }),
        onResourcesChanged: (server) => bus.publish(McpEvent.ResourcesChanged, { server }),
      },
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.layout, PlatformNode.childProcessSpawner, Bus.node, hostNode],
})
