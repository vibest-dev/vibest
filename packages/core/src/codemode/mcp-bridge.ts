import { Json } from "@vibest/schema/json"
import type { Mcp as McpSchema } from "@vibest/schema/mcp"
import { SchemaType } from "@vibest/util/schema-type"
import { Effect, Option, type Schema } from "effect"

import type { Mcp } from "../mcp.ts"

export interface CodeModeTool {
  readonly server: string
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: Schema.JsonObject | undefined
  readonly outputSchema?: Schema.JsonObject | undefined
  readonly execute: (
    args: Schema.Json | undefined,
  ) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>
}

export interface MountedMcpTools {
  readonly servers: ReadonlyArray<string>
  readonly tools: ReadonlyArray<CodeModeTool>
}

const { isJsonObject, parseJsonOption } = Json

const textFromContent = (content: ReadonlyArray<McpSchema.CallContent>): string => {
  const parts: Array<string> = []

  for (const item of content) {
    if (item.type === "text") parts.push(item.text)
  }

  return parts.join("\n")
}

export const unwrapMcpCallResult = (
  result: McpSchema.CallResult,
): Effect.Effect<Schema.Json | undefined, { readonly message: string }> => {
  if (result.isError) {
    const message = textFromContent(result.content).trim()

    return Effect.fail({ message: message.length > 0 ? message : "MCP tool call returned an error" })
  }

  if (result.structured !== undefined) {
    return Effect.succeed(result.structured)
  }

  if (result.content.length === 0) {
    return Effect.succeed(undefined)
  }

  const allText = result.content.every((item) => item.type === "text")

  if (!allText) {
    return Effect.succeed(
      result.content.map((item) =>
        item.type === "text"
          ? { type: "text", text: item.text }
          : {
              type: "media",
              data: item.data,
              mimeType: item.mimeType,
              ...(item.uri !== undefined && { uri: item.uri }),
            },
      ),
    )
  }

  const joined = textFromContent(result.content)
  const trimmed = joined.trim()

  if (trimmed.length > 0) {
    const parsed = parseJsonOption(trimmed)

    if (Option.isSome(parsed)) return Effect.succeed(parsed.value)
  }

  return Effect.succeed(joined)
}

export const createLazyMcpDispatcher = Effect.fn("CodeModeMcpBridge.createLazyMcpDispatcher")(function* (
  mcp: Mcp.Interface,
  options: {
    readonly directory?: string | undefined
    readonly servers?: ReadonlyArray<string> | undefined
  } = {},
): Effect.fn.Return<
  (
    server: string,
    tool: string,
    args: Schema.Json | undefined,
  ) => Effect.Effect<Schema.Json | undefined, { readonly message: string }>
> {
  const listed = yield* mcp.list(options.directory)
  const allowed = options.servers !== undefined ? new Set(options.servers) : undefined
  const byKey = new Map<string, McpSchema.ServerInfo>()
  const toolMaps = new Map<string, ReadonlyMap<string, string>>()

  for (const server of listed) {
    byKey.set(server.name, server)
    const jsName = SchemaType.toIdentifier(server.name)

    if (!byKey.has(jsName)) byKey.set(jsName, server)
  }

  const resolveToolName = (serverName: string, requested: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      let map = toolMaps.get(serverName)

      if (map === undefined) {
        const serverTools = yield* mcp.tools(serverName, options.directory).pipe(Effect.orElseSucceed(() => []))
        const built = new Map<string, string>()

        for (const item of serverTools) {
          built.set(item.name, item.name)
          const jsName = SchemaType.toIdentifier(item.name)

          if (!built.has(jsName)) built.set(jsName, item.name)
        }

        toolMaps.set(serverName, built)
        map = built
      }

      return map.get(requested) ?? requested
    })

  return (server, tool, args) => {
    const info = byKey.get(server)

    if (!info) {
      return Effect.fail({ message: `Unknown MCP server "${server}"` })
    }

    if (info.disabled) {
      return Effect.fail({ message: `MCP server "${info.name}" is disabled` })
    }

    if (info.codemode === false) {
      return Effect.fail({ message: `MCP server "${info.name}" is not enabled for CodeMode` })
    }

    if (allowed && !allowed.has(info.name)) {
      return Effect.fail({ message: `MCP server "${info.name}" is not included in the allowed servers list` })
    }

    return resolveToolName(info.name, tool).pipe(
      Effect.flatMap((resolvedTool) =>
        mcp.call({
          server: info.name,
          tool: resolvedTool,
          args: isJsonObject(args) ? args : {},
          directory: options.directory,
        }),
      ),
      Effect.mapError((error) => ({ message: error.message })),
      Effect.flatMap(unwrapMcpCallResult),
    )
  }
})

export const mountMcpTools = Effect.fn("CodeModeMcpBridge.mountMcpTools")(function* (
  mcp: Mcp.Interface,
  options: {
    readonly directory?: string | undefined
    readonly servers?: ReadonlyArray<string> | undefined
  } = {},
): Effect.fn.Return<MountedMcpTools> {
  const listed = yield* mcp.list(options.directory)
  const allowed = options.servers !== undefined ? new Set(options.servers) : undefined

  const eligible = listed.filter(
    (server) => !server.disabled && server.codemode !== false && (!allowed || allowed.has(server.name)),
  )

  const fetched = yield* Effect.forEach(
    eligible,
    (server) =>
      mcp.tools(server.name, options.directory).pipe(
        Effect.orElseSucceed(() => []),
        Effect.map((serverTools) => ({ server, serverTools })),
      ),
    { concurrency: "unbounded" },
  )

  const mountedServers: Array<string> = []
  const tools: Array<CodeModeTool> = []

  for (const { server, serverTools } of fetched) {
    mountedServers.push(server.name)

    for (const tool of serverTools) {
      tools.push({
        server: tool.server,
        name: tool.name,
        ...(tool.description !== undefined && { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
        execute: (args) =>
          mcp
            .call({
              server: tool.server,
              tool: tool.name,
              args: isJsonObject(args) ? args : {},
              directory: options.directory,
            })
            .pipe(
              Effect.mapError((error) => ({ message: error.message })),
              Effect.flatMap(unwrapMcpCallResult),
            ),
      })
    }
  }

  return {
    servers: mountedServers,
    tools,
  }
})
