import type { AuthProvider } from "@modelcontextprotocol/client"
import { Bus } from "@vibest/core/bus"
import { PrivateFile } from "@vibest/core/effect/private-file"
import { Mcp as McpSchema } from "@vibest/schema/mcp"
import { McpEvent } from "@vibest/schema/mcp-event"
import type { KeyedMutex } from "@vibest/util/keyed-mutex"
import { Clock, Effect, type FileSystem, Latch, Option, type Path, type Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import type { McpClient } from "./client.ts"
import { decodeConfigFile, toolAllowed, toToolInfo } from "./helpers.ts"
import { McpMetadataCache } from "./metadata-cache.ts"
import { McpOAuth } from "./oauth.ts"
import { McpPool } from "./pool.ts"
import { McpSecrets } from "./secrets.ts"
import { McpStdio } from "./stdio.ts"
import { McpVault } from "./vault.ts"

export interface ServerEntry {
  readonly name: McpSchema.ServerName
  readonly config: McpSchema.ServerConfig
  readonly directory: string
  status: McpSchema.Status
  readonly startup: Latch.Latch
  attempt: { readonly started: number; readonly settled: Latch.Latch } | undefined
  readonly connection: McpPool.PooledConnection
  tagged:
    | { readonly source: ReadonlyArray<McpClient.Tool>; readonly tools: ReadonlyArray<McpSchema.ToolInfo> }
    | undefined
}

export interface EntryContext {
  readonly vibestHome: string
  readonly configPath: string
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly bus: Bus.Interface
  readonly fetch: typeof globalThis.fetch
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly pool: McpPool.Interface
  readonly vault: McpVault.Interface
  readonly metadataCache: McpMetadataCache.Interface
  readonly servers: Scope.Closeable
  readonly locks: ReturnType<typeof KeyedMutex.makeUnsafe<string>>
  readonly callbacks: (effect: Effect.Effect<void>) => void
  readonly fork: (effect: Effect.Effect<void>) => void
  readonly heldEntries: Map<string, ServerEntry>
  readonly lastStatus: Map<string, McpSchema.Status>
  readonly clientInfo?: { readonly name: string; readonly version: string } | undefined
}

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
  ctx: Pick<EntryContext, "fs" | "path" | "configPath">,
  configured: Readonly<Record<string, McpSchema.ServerConfig>>,
): Effect.Effect<void, McpSchema.ConfigError> =>
  PrivateFile.writeAtomic(ctx.fs, ctx.path, ctx.configPath, JSON.stringify({ mcpServers: configured }, null, 2)).pipe(
    Effect.mapError((error) => new McpSchema.ConfigError({ message: error.message })),
  )

export const loadConfiguredServers = (
  ctx: Pick<EntryContext, "fs" | "path" | "configPath">,
  directory?: string,
): Effect.Effect<Record<string, McpSchema.ServerConfig>> =>
  Effect.gen(function* () {
    const globalServers = yield* readConfigFile(ctx.fs, ctx.configPath)

    if (!directory) return globalServers
    const projectConfigPath = ctx.path.join(directory, ".mcp.json")
    const projectServers = yield* readConfigFile(ctx.fs, projectConfigPath)

    return { ...globalServers, ...projectServers }
  })

export const fingerprintFor = (config: McpSchema.ServerConfig, directory: string, credentialId?: string): string =>
  McpMetadataCache.computeFingerprint({
    config,
    ...(config.type === "local" && { resolvedCwd: McpStdio.resolveCwd(directory, config.cwd) }),
    ...(credentialId !== undefined && { credentialId }),
  })

export const emitStatus = (
  ctx: Pick<EntryContext, "bus" | "lastStatus">,
  server: McpSchema.ServerName,
  status: McpSchema.Status,
) =>
  Effect.gen(function* () {
    ctx.lastStatus.set(server, status)
    yield* ctx.bus.publish(McpEvent.StatusChanged, { server, status })
  })

export const serverTools = (entry: ServerEntry): ReadonlyArray<McpSchema.ToolInfo> => {
  const source = entry.connection.tools

  if (!source) return []

  if (entry.tagged?.source !== source) {
    entry.tagged = {
      source,
      tools: source.filter((tool) => toolAllowed(tool.name, entry.config)).map((tool) => toToolInfo(entry.name, tool)),
    }
  }

  return entry.tagged.tools
}

export const cacheTools = (
  ctx: Pick<EntryContext, "vault" | "metadataCache">,
  entry: ServerEntry,
): Effect.Effect<ReadonlyArray<McpSchema.ToolInfo>> =>
  Effect.gen(function* () {
    const filtered = serverTools(entry)
    const now = yield* Clock.currentTimeMillis

    const credId =
      entry.config.type === "remote"
        ? (yield* ctx.vault.get(entry.name, entry.config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
        : undefined

    yield* ctx.metadataCache.set(entry.name, entry.config, {
      fingerprint: fingerprintFor(entry.config, entry.directory, credId),
      cachedAt: now,
      ...(entry.connection.toolsMeta?.cacheScope !== undefined && {
        cacheScope: entry.connection.toolsMeta.cacheScope,
      }),
      ...(entry.connection.toolsMeta?.ttlMs !== undefined && { ttlMs: entry.connection.toolsMeta.ttlMs }),
      ...(entry.connection.client?.title !== undefined && { title: entry.connection.client.title }),
      ...(entry.connection.client?.instructions !== undefined && {
        instructions: entry.connection.client.instructions,
      }),
      tools: filtered,
    })

    return filtered
  })

export const cachedToolsFor = (
  ctx: Pick<EntryContext, "heldEntries" | "vault" | "metadataCache">,
  name: McpSchema.ServerName,
  config: McpSchema.ServerConfig,
  directory: string,
): Effect.Effect<ReadonlyArray<McpSchema.ToolInfo>> =>
  Effect.gen(function* () {
    const held = ctx.heldEntries.get(name)

    if (held?.connection.tools) return serverTools(held)

    const credId =
      config.type === "remote"
        ? (yield* ctx.vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
        : undefined

    const cached = yield* ctx.metadataCache.get(name, fingerprintFor(config, directory, credId))

    return cached ? cached.tools : []
  })

export const toServerInfo = (
  ctx: Pick<EntryContext, "heldEntries" | "lastStatus" | "vault" | "metadataCache">,
  name: McpSchema.ServerName,
  config: McpSchema.ServerConfig,
  directory: string,
  held?: ServerEntry,
): Effect.Effect<McpSchema.ServerInfo> =>
  Effect.gen(function* () {
    const toolsList = yield* cachedToolsFor(ctx, name, config, directory)

    const status: McpSchema.Status = config.disabled
      ? { status: "disabled" }
      : (held?.status ?? ctx.lastStatus.get(name) ?? { status: "idle" })

    return {
      name,
      type: config.type,
      exposure: config.exposure ?? "skill",
      status,
      ...(held?.connection.client?.title !== undefined && { title: held.connection.client.title }),
      ...(held?.connection.client?.instructions !== undefined && {
        instructions: held.connection.client.instructions,
      }),
      ...(held?.connection.client?.capabilities !== undefined && {
        capabilities: held.connection.client.capabilities,
      }),
      toolCount: toolsList.length,
      ...(config.pool !== undefined && { pooled: config.pool }),
      ...(config.codemode !== undefined && { codemode: config.codemode }),
      ...(config.disabled !== undefined && { disabled: config.disabled }),
      ...(config.type === "remote" && { url: config.url }),
      ...(config.type === "local" && { command: [...config.command] }),
    }
  })

const makeAuthProvider = (
  ctx: Pick<EntryContext, "spawner" | "fetch" | "vault">,
  name: McpSchema.ServerName,
  config: McpSchema.ServerConfig,
): Effect.Effect<AuthProvider | undefined> =>
  Effect.gen(function* () {
    if (config.type !== "remote") return undefined

    const resolvedHeaders = yield* McpSecrets.resolveRecord(config.headers, `${name}.headers`).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ctx.spawner),
      Effect.orElseSucceed(() => config.headers),
    )

    const fetchFn = yield* McpOAuth.loggedFetch({
      server: name,
      serverUrl: config.url,
      customHeaders: resolvedHeaders,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, ctx.fetch))

    return yield* McpOAuth.connectProvider({ server: name, config, vault: ctx.vault, fetchFn }).pipe(
      Effect.provideService(McpVault.Service, ctx.vault),
      Effect.provideService(FetchHttpClient.Fetch, ctx.fetch),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ctx.spawner),
    )
  })

export const createServerEntry = (
  ctx: EntryContext,
  name: McpSchema.ServerName,
  config: McpSchema.ServerConfig,
  directory: string,
): ServerEntry => {
  const emitTools = () => ctx.bus.publish(McpEvent.ToolsChanged, { server: name })
  const emitResources = () => ctx.bus.publish(McpEvent.ResourcesChanged, { server: name })

  const entry: ServerEntry = {
    name,
    config,
    directory,
    status: config.disabled ? { status: "disabled" } : { status: "idle" },
    startup: Latch.makeUnsafe(),
    attempt: undefined,
    tagged: undefined,
    connection: ctx.pool.connection({
      name,
      config: config.pool !== false && config.protocol === undefined ? { ...config, protocol: "auto" } : config,
      directory,
      vibestHome: ctx.vibestHome,
      clientInfo: ctx.clientInfo,
      mcpEvents: true,
      authProvider: makeAuthProvider(ctx, name, config),
      select: Effect.gen(function* () {
        if (config.type === "remote") {
          const cred = yield* ctx.vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined))

          return {
            key: McpPool.key({
              config,
              credentialId: cred?.id,
              clientInfo: ctx.clientInfo,
              mcpEvents: true,
            }),
            authProvider: makeAuthProvider(ctx, name, config),
          }
        }

        const resolvedCwd = McpStdio.resolveCwd(directory, config.cwd)

        return {
          key: McpPool.key({
            config,
            cwd: resolvedCwd,
            clientInfo: ctx.clientInfo,
            mcpEvents: true,
          }),
          authProvider: Effect.succeed(undefined),
        }
      }),
      scope: ctx.servers,
      lock: ctx.locks.withLock(name),
      callbacks: ctx.callbacks,
      fork: ctx.fork,
      events: {
        connecting: Effect.gen(function* () {
          if (!entry.attempt || entry.status.status !== "pending") {
            entry.attempt = { started: yield* Clock.currentTimeMillis, settled: Latch.makeUnsafe() }
          }

          entry.status = { status: "pending" }
          yield* emitStatus(ctx, name, entry.status)
        }),
        connected: Effect.gen(function* () {
          entry.status = { status: "connected" }
          yield* cacheTools(ctx, entry)
          yield* emitTools()
          yield* emitResources()
          yield* emitStatus(ctx, name, entry.status)
        }),
        failed: (failure) =>
          Effect.gen(function* () {
            entry.status = failure
            yield* emitStatus(ctx, name, entry.status)
          }),
        settled: Effect.suspend(() => {
          const attempt = entry.attempt
          entry.attempt = undefined

          return (attempt ? attempt.settled.open : Effect.void).pipe(Effect.ensuring(entry.startup.open))
        }),
        closed: (reason) =>
          Effect.gen(function* () {
            yield* entry.connection.stop
            entry.status = { status: "failed", error: reason }
            yield* emitStatus(ctx, name, entry.status)
          }),
        changed: (kind) =>
          Effect.gen(function* () {
            if (kind === "tools") {
              if (entry.connection.tools !== undefined) {
                yield* cacheTools(ctx, entry)
              }

              yield* emitTools()
            } else if (kind === "resources") {
              yield* emitResources()
            }
          }),
      },
    }),
  }

  return entry
}
