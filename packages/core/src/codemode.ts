import type { CodeMode as CodeModeSchema } from "@vibest/schema/codemode"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer, type Result, type Schema, type Scope } from "effect"

import { createLazyMcpDispatcher, mountMcpTools, type CodeModeTool } from "./codemode/mcp-bridge.ts"
import { Mcp } from "./mcp.ts"

export * as CodeMode from "./codemode.ts"

export type ToolDispatcher = (
  server: string,
  tool: string,
  args: Schema.Json | undefined,
) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>

export type ToolPolicy = (path: string) => Result.Result<void, string>

export interface EngineExecuteInput {
  readonly code: string
  readonly tools?: ReadonlyArray<CodeModeTool> | undefined
  readonly callTool?: ToolDispatcher | undefined
  readonly allowTool?: ToolPolicy | undefined
  readonly bindings?: Schema.JsonObject | undefined
  readonly state?: Schema.JsonObject | undefined
  readonly limits?: CodeModeSchema.ExecutionLimits | undefined
}

export interface ExecuteOptions {
  readonly allowTool?: ToolPolicy | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly allowedExternalServers?: ReadonlyArray<string> | undefined
}

export interface BuiltinToolsProvider {
  readonly namespace: string
  readonly list: () => ReadonlyArray<CodeModeTool>
  readonly execute: (input: {
    readonly tool: string
    readonly args: Schema.Json | undefined
    readonly directory?: string | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined
  }) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>
}

export const BuiltinTools = Context.Reference<BuiltinToolsProvider | undefined>("vibest/CodeMode/BuiltinTools", {
  defaultValue: () => undefined,
})

export const builtinToolsNode = LayerNode.make({
  service: BuiltinTools,
  layer: Layer.succeed(BuiltinTools, undefined),
  deps: [],
})

export interface HostEngine {
  readonly execute: (input: EngineExecuteInput) => Effect.Effect<CodeModeSchema.ExecutionResult>
  readonly checkSyntax: (code: string) => Result.Result<void, string>
  readonly renderDeclarations: (tools: ReadonlyArray<CodeModeTool>) => string
}

export type HostFactory = () => Effect.Effect<HostEngine, never, Scope.Scope>

export class Host extends Context.Service<Host, HostFactory>()("vibest/CodeModeHost") {}

export const hostNode = LayerNode.unbound(Host)

export interface Interface {
  readonly execute: (
    request: CodeModeSchema.ExecuteRequest,
    options?: ExecuteOptions,
  ) => Effect.Effect<CodeModeSchema.ExecutionResult>
  readonly checkSyntax: (code: string) => Result.Result<void, string>
  readonly declarations: (input?: {
    readonly directory?: string | undefined
    readonly servers?: ReadonlyArray<string> | undefined
    readonly allowedExternalServers?: ReadonlyArray<string> | undefined
  }) => Effect.Effect<CodeModeSchema.DeclarationsResult>
}

export class Service extends Context.Service<Service, Interface>()("vibest/CodeMode") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const makeHost = yield* Host
    const builtinTools = yield* BuiltinTools
    const engine = yield* makeHost()

    const partitionServers = (
      servers: ReadonlyArray<string> | undefined,
      allowedExternalServers?: ReadonlyArray<string> | undefined,
    ) => {
      if (servers === undefined || servers.length === 0) {
        return { includeBuiltin: builtinTools !== undefined, externalServers: allowedExternalServers }
      }

      const includeBuiltin = builtinTools !== undefined && servers.includes(builtinTools.namespace)

      const requestedExternal =
        builtinTools !== undefined ? servers.filter((name) => name !== builtinTools.namespace) : servers

      if (allowedExternalServers === undefined) {
        return { includeBuiltin, externalServers: requestedExternal }
      }

      const allowedSet = new Set(allowedExternalServers)

      return {
        includeBuiltin,
        externalServers: requestedExternal.filter((name) => allowedSet.has(name)),
      }
    }

    const execute = Effect.fn("CodeMode.execute")(function* (
      request: CodeModeSchema.ExecuteRequest,
      options?: ExecuteOptions,
    ): Effect.fn.Return<CodeModeSchema.ExecutionResult> {
      const { includeBuiltin, externalServers } = partitionServers(request.servers, options?.allowedExternalServers)

      const mcpDispatcher = yield* createLazyMcpDispatcher(mcp, {
        directory: request.directory,
        servers: externalServers,
      })

      const callTool: ToolDispatcher = (server, tool, args) => {
        if (builtinTools !== undefined && server === builtinTools.namespace) {
          if (!includeBuiltin) {
            return Effect.fail({
              message: `Built-in server "${builtinTools.namespace}" is not included in the allowed servers list`,
            })
          }

          return builtinTools.execute({
            tool,
            args,
            directory: request.directory,
            headers: options?.headers,
          })
        }

        return mcpDispatcher(server, tool, args)
      }

      return yield* engine.execute({
        code: request.code,
        callTool,
        ...(options?.allowTool !== undefined && { allowTool: options.allowTool }),
        ...(request.bindings !== undefined && { bindings: request.bindings }),
        ...(request.state !== undefined && { state: request.state }),
        ...(request.limits !== undefined && { limits: request.limits }),
      })
    })

    const declarations = Effect.fn("CodeMode.declarations")(function* (
      input: {
        readonly directory?: string | undefined
        readonly servers?: ReadonlyArray<string> | undefined
        readonly allowedExternalServers?: ReadonlyArray<string> | undefined
      } = {},
    ): Effect.fn.Return<CodeModeSchema.DeclarationsResult> {
      const { includeBuiltin, externalServers } = partitionServers(input.servers, input.allowedExternalServers)

      const mounted = yield* mountMcpTools(mcp, {
        directory: input.directory,
        servers: externalServers,
      })

      const builtinList = includeBuiltin && builtinTools !== undefined ? builtinTools.list() : []
      const allTools = [...builtinList, ...mounted.tools]

      const allServers = [
        ...(includeBuiltin && builtinTools !== undefined ? [builtinTools.namespace] : []),
        ...mounted.servers,
      ]

      return {
        declarations: engine.renderDeclarations(allTools),
        servers: allServers,
        toolCount: allTools.length,
      }
    })

    return {
      execute,
      checkSyntax: engine.checkSyntax,
      declarations,
    }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Mcp.node, hostNode, builtinToolsNode],
})
