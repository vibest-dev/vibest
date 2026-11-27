import crypto from "node:crypto"

import { PrivateFile } from "@vibest/core/effect/private-file"
import { Mcp as McpSchema } from "@vibest/schema/mcp"
import { SchemaType } from "@vibest/util/schema-type"
import { Effect, Option, Schema, type FileSystem, type Path } from "effect"

import type { McpClient } from "./client.ts"

export const decodeConfigFile = Schema.decodeUnknownOption(McpSchema.ConfigFile)
export const decodeServerName = Schema.decodeUnknownOption(McpSchema.ServerName)

export const readConfigFile = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<Record<string, McpSchema.ServerConfig>> =>
  fs.readFileString(filePath).pipe(
    Effect.map((raw) => {
      try {
        const decoded = decodeConfigFile(JSON.parse(raw))

        return Option.isSome(decoded) ? { ...decoded.value.mcpServers } : {}
      } catch {
        return {}
      }
    }),
    Effect.orElseSucceed(() => ({})),
  )

export const writeGlobalConfig = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configPath: string,
  configured: Readonly<Record<string, McpSchema.ServerConfig>>,
): Effect.Effect<void, McpSchema.ConfigError> =>
  PrivateFile.writeAtomic(fs, path, configPath, JSON.stringify({ mcpServers: configured }, null, 2)).pipe(
    Effect.mapError((error) => new McpSchema.ConfigError({ message: error.message })),
  )

export const loadConfiguredServers = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  configPath: string,
  directory?: string,
): Effect.Effect<Record<string, McpSchema.ServerConfig>> =>
  Effect.gen(function* () {
    const globalServers = yield* readConfigFile(fs, configPath)

    if (!directory) return globalServers
    const projectServers = yield* readConfigFile(fs, path.join(directory, ".mcp.json"))

    return { ...globalServers, ...projectServers }
  })

export const parseServerName = (raw: string): Effect.Effect<McpSchema.ServerName, McpSchema.ConfigError> => {
  const decoded = decodeServerName(raw)

  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new McpSchema.ConfigError({ message: `Invalid MCP server name: ${raw}` }))
}

export const toolAllowed = (toolName: string, config: McpSchema.ServerConfig): boolean => {
  if (config.includeTools && config.includeTools.length > 0 && !config.includeTools.includes(toolName)) {
    return false
  }

  if (config.excludeTools && config.excludeTools.includes(toolName)) {
    return false
  }

  return true
}

export const toToolInfo = (server: McpSchema.ServerName, tool: McpClient.Tool): McpSchema.ToolInfo => ({
  server,
  name: tool.name,
  ...(tool.title !== undefined && { title: tool.title }),
  ...(tool.description !== undefined && { description: tool.description }),
  signature: SchemaType.renderToolSignature(tool.inputSchema),
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
  ...(tool.annotations !== undefined && { annotations: tool.annotations }),
})

export const verifySkillDigest = (
  server: string,
  uri: string,
  expectedDigest: string,
  contents: ReadonlyArray<McpSchema.ResourceContent>,
): Effect.Effect<void, McpSchema.ToolCallError> => {
  const normalized = expectedDigest.trim().toLowerCase()

  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    return Effect.fail(
      new McpSchema.ToolCallError({
        server,
        tool: "resources/read",
        message: `Unsupported skill resource digest format for "${uri}": ${expectedDigest}`,
      }),
    )
  }

  const expectedHex = normalized.slice("sha256:".length)
  const hash = crypto.createHash("sha256")

  for (const item of contents) {
    if (item.text !== undefined) {
      hash.update(Buffer.from(item.text, "utf8"))
    } else if (item.blob !== undefined) {
      hash.update(Buffer.from(item.blob, "base64"))
    }
  }

  const actualHex = hash.digest("hex")
  const matches = crypto.timingSafeEqual(Buffer.from(actualHex, "hex"), Buffer.from(expectedHex, "hex"))

  return matches
    ? Effect.void
    : Effect.fail(
        new McpSchema.ToolCallError({
          server,
          tool: "resources/read",
          message: `SHA-256 digest mismatch for "${uri}": expected sha256:${expectedHex}, got sha256:${actualHex}`,
        }),
      )
}
