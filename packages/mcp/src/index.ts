import type { AuthProvider } from "@modelcontextprotocol/client"
import { Bus } from "@vibest/core/bus"
import { PlatformNode } from "@vibest/core/effect/platform"
import { PrivateFile } from "@vibest/core/effect/private-file"
import { Mcp as CoreMcp } from "@vibest/core/mcp"
import { Layout } from "@vibest/schema/layout"
import { Mcp as McpSchema } from "@vibest/schema/mcp"
import { McpEvent } from "@vibest/schema/mcp-event"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Latch,
  Layer,
  Option,
  Path,
  Scope,
  Semaphore,
  type Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import type { McpClient } from "./client.ts"
import {
  decodeConfigFile,
  decodeServerName,
  parseServerName,
  toolAllowed,
  toToolInfo,
  verifySkillDigest,
} from "./helpers.ts"
import { McpMetadataCache } from "./metadata-cache.ts"
import { McpOAuth } from "./oauth.ts"
import { McpPool } from "./pool.ts"
import { McpSecrets } from "./secrets.ts"
import { McpStdio } from "./stdio.ts"
import { McpVault } from "./vault.ts"

export * as Mcp from "./index.ts"

export { McpClient } from "./client.ts"

export { McpConnection } from "./connection.ts"

export * from "./errors.ts"

export { McpMetadataCache } from "./metadata-cache.ts"

export { NpxResolver } from "./npx-resolver.ts"

export { McpOAuth } from "./oauth.ts"

export { McpPool } from "./pool.ts"

export { McpSecrets } from "./secrets.ts"

export { McpStdio } from "./stdio.ts"

export { McpVault } from "./vault.ts"

const STARTUP_GRACE_MS = 2_000

interface ServerEntry {
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

export interface Options {
  readonly clientInfo?: { readonly name: string; readonly version: string } | undefined
}

export const make = Effect.fn("Mcp.make")(function* (options?: Options) {
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bus = yield* Bus.Service
  const fetch = yield* FetchHttpClient.Fetch
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const pool = yield* McpPool.Service
  const vault = yield* McpVault.Service
  const metadataCache = yield* McpMetadataCache.Service
  const root = yield* Effect.scope
  const fork = yield* FiberSet.makeRuntime<never, void, never>()
  const servers = yield* Scope.fork(root, "parallel")
  const callbacks = yield* FiberSet.makeRuntime<never, void, never>()

  const authManager = yield* McpOAuth.makeAuthManager()
  const locks = KeyedMutex.makeUnsafe<string>()
  const reconcileLock = Semaphore.makeUnsafe(1)
  const configPath = path.join(layout.home, "mcp.json")
  const heldEntries = new Map<string, ServerEntry>()
  const lastStatus = new Map<string, McpSchema.Status>()

  const transition = <E>(effect: Effect.Effect<void, E>) =>
    Effect.forkIn(effect, root, { startImmediately: true }).pipe(Effect.flatMap(Fiber.join))

  yield* Scope.addFinalizer(
    root,
    Effect.gen(function* () {
      yield* authManager.closeAll.pipe(Effect.ignore)
      yield* pool.closeAll.pipe(Effect.ignore)
      yield* Scope.close(servers, Exit.void).pipe(Effect.ignore)
    }),
  )

  const emitStatus = (server: McpSchema.ServerName, status: McpSchema.Status) =>
    Effect.gen(function* () {
      lastStatus.set(server, status)
      yield* bus.publish(McpEvent.StatusChanged, { server, status })
    })

  const emitTools = (server: McpSchema.ServerName) => bus.publish(McpEvent.ToolsChanged, { server })
  const emitResources = (server: McpSchema.ServerName) => bus.publish(McpEvent.ResourcesChanged, { server })

  const readConfigFile = (filePath: string): Effect.Effect<Record<string, McpSchema.ServerConfig>> =>
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

  const writeGlobalConfig = (
    configured: Readonly<Record<string, McpSchema.ServerConfig>>,
  ): Effect.Effect<void, McpSchema.ConfigError> =>
    PrivateFile.writeAtomic(fs, path, configPath, JSON.stringify({ mcpServers: configured }, null, 2)).pipe(
      Effect.mapError((error) => new McpSchema.ConfigError({ message: error.message })),
    )

  const loadConfiguredServers = (directory?: string): Effect.Effect<Record<string, McpSchema.ServerConfig>> =>
    Effect.gen(function* () {
      const globalServers = yield* readConfigFile(configPath)

      if (!directory) return globalServers
      const projectConfigPath = path.join(directory, ".mcp.json")
      const projectServers = yield* readConfigFile(projectConfigPath)

      return { ...globalServers, ...projectServers }
    })

  const fingerprintFor = (config: McpSchema.ServerConfig, directory: string, credentialId?: string): string =>
    McpMetadataCache.computeFingerprint({
      config,
      ...(config.type === "local" && { resolvedCwd: McpStdio.resolveCwd(directory, config.cwd) }),
      ...(credentialId !== undefined && { credentialId }),
    })

  const makeAuthProvider = (
    name: McpSchema.ServerName,
    config: McpSchema.ServerConfig,
  ): Effect.Effect<AuthProvider | undefined> =>
    Effect.gen(function* () {
      if (config.type !== "remote") return undefined

      const resolvedHeaders = yield* McpSecrets.resolveRecord(config.headers, `${name}.headers`).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => config.headers),
      )

      const fetchFn = yield* McpOAuth.loggedFetch({
        server: name,
        serverUrl: config.url,
        customHeaders: resolvedHeaders,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))

      return yield* McpOAuth.connectProvider({ server: name, config, vault, fetchFn }).pipe(
        Effect.provideService(McpVault.Service, vault),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
    })

  const serverTools = (entry: ServerEntry): ReadonlyArray<McpSchema.ToolInfo> => {
    const source = entry.connection.tools

    if (!source) return []

    if (entry.tagged?.source !== source) {
      entry.tagged = {
        source,
        tools: source
          .filter((tool) => toolAllowed(tool.name, entry.config))
          .map((tool) => toToolInfo(entry.name, tool)),
      }
    }

    return entry.tagged.tools
  }

  const cacheTools = (entry: ServerEntry): Effect.Effect<ReadonlyArray<McpSchema.ToolInfo>> =>
    Effect.gen(function* () {
      const filtered = serverTools(entry)
      const now = yield* Clock.currentTimeMillis

      const credId =
        entry.config.type === "remote"
          ? (yield* vault.get(entry.name, entry.config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
          : undefined

      yield* metadataCache.set(entry.name, entry.config, {
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

  const makeEntry = (name: McpSchema.ServerName, config: McpSchema.ServerConfig, directory: string): ServerEntry => {
    const entry: ServerEntry = {
      name,
      config,
      directory,
      status: config.disabled ? { status: "disabled" } : { status: "idle" },
      startup: Latch.makeUnsafe(),
      attempt: undefined,
      tagged: undefined,
      connection: pool.connection({
        name,
        config: config.pool !== false && config.protocol === undefined ? { ...config, protocol: "auto" } : config,
        directory,
        vibestHome: layout.home,
        clientInfo: options?.clientInfo,
        mcpEvents: true,
        authProvider: makeAuthProvider(name, config),
        select: Effect.gen(function* () {
          if (config.type === "remote") {
            const cred = yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined))

            return {
              key: McpPool.key({
                config,
                credentialId: cred?.id,
                clientInfo: options?.clientInfo,
                mcpEvents: true,
              }),
              authProvider: makeAuthProvider(name, config),
            }
          }

          const resolvedCwd = McpStdio.resolveCwd(directory, config.cwd)

          return {
            key: McpPool.key({
              config,
              cwd: resolvedCwd,
              clientInfo: options?.clientInfo,
              mcpEvents: true,
            }),
            authProvider: Effect.succeed(undefined),
          }
        }),
        scope: servers,
        lock: locks.withLock(name),
        callbacks: (effect) => {
          callbacks(effect)
        },
        fork: (effect) => {
          fork(effect)
        },
        events: {
          connecting: Effect.gen(function* () {
            if (!entry.attempt || entry.status.status !== "pending") {
              entry.attempt = { started: yield* Clock.currentTimeMillis, settled: Latch.makeUnsafe() }
            }

            entry.status = { status: "pending" }
            yield* emitStatus(name, entry.status)
          }),
          connected: Effect.gen(function* () {
            entry.status = { status: "connected" }
            yield* cacheTools(entry)
            yield* emitTools(name)
            yield* emitResources(name)
            yield* emitStatus(name, entry.status)
          }),
          failed: (failure) =>
            Effect.gen(function* () {
              entry.status = failure
              yield* emitStatus(name, entry.status)
            }),
          settled: Effect.suspend(() => {
            const attempt = entry.attempt
            entry.attempt = undefined

            return (attempt ? attempt.settled.open : Effect.void).pipe(Effect.ensuring(entry.startup.open))
          }),
          closed: (reason) =>
            Effect.gen(function* () {
              entry.status = { status: "failed", error: reason }
              yield* emitStatus(name, entry.status)
            }),
          changed: (kind) =>
            Effect.gen(function* () {
              if (kind === "tools") {
                if (entry.connection.tools !== undefined) {
                  yield* cacheTools(entry)
                }

                yield* emitTools(name)
              } else if (kind === "resources") {
                yield* emitResources(name)
              }
            }),
        },
      }),
    }

    return entry
  }

  const resolveConfigured = Effect.fn("Mcp.resolveConfigured")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<
    { readonly name: McpSchema.ServerName; readonly config: McpSchema.ServerConfig; readonly directory: string },
    McpSchema.NotFoundError
  > {
    const dir = directory ?? layout.home
    const configured = yield* loadConfiguredServers(directory)
    const config = configured[rawServer]

    if (!config) {
      return yield* new McpSchema.NotFoundError({ server: rawServer, message: `MCP server not found: ${rawServer}` })
    }

    const decoded = decodeServerName(rawServer)

    if (Option.isNone(decoded)) {
      return yield* new McpSchema.NotFoundError({
        server: rawServer,
        message: `Invalid MCP server name: ${rawServer}`,
      })
    }

    return { name: decoded.value, config, directory: dir }
  })

  const withActiveEntry = <A, E>(
    rawServer: string,
    directory: string | undefined,
    run: (entry: ServerEntry) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | McpSchema.NotFoundError> =>
    Effect.gen(function* () {
      const resolved = yield* resolveConfigured(rawServer, directory)
      const held = heldEntries.get(rawServer)

      if (
        held &&
        JSON.stringify(held.config) === JSON.stringify(resolved.config) &&
        held.directory === resolved.directory
      ) {
        if (!held.config.disabled && !held.connection.client) {
          yield* transition(held.connection.start.pipe(locks.withLock(rawServer)))
        }

        return yield* run(held)
      }

      return yield* Effect.scoped(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const ephemeral = makeEntry(resolved.name, resolved.config, resolved.directory)

            if (!ephemeral.config.disabled) {
              yield* transition(ephemeral.connection.start.pipe(locks.withLock(rawServer)))
            }

            return ephemeral
          }),
          (ephemeral) =>
            transition(
              ephemeral.connection.stop.pipe(
                locks.withLock(rawServer),
                Effect.andThen(
                  Effect.sync(() => {
                    if (!heldEntries.has(rawServer) && !ephemeral.config.disabled) {
                      lastStatus.set(rawServer, { status: "idle" })
                    }
                  }),
                ),
              ),
            ).pipe(Effect.ignore),
        ).pipe(Effect.flatMap(run)),
      )
    })

  const cachedToolsFor = (
    name: McpSchema.ServerName,
    config: McpSchema.ServerConfig,
    directory: string,
  ): Effect.Effect<ReadonlyArray<McpSchema.ToolInfo>> =>
    Effect.gen(function* () {
      const held = heldEntries.get(name)

      if (held?.connection.tools) return serverTools(held)

      const credId =
        config.type === "remote"
          ? (yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
          : undefined

      const cached = yield* metadataCache.get(name, fingerprintFor(config, directory, credId))

      return cached ? cached.tools : []
    })

  const toServerInfo = (
    name: McpSchema.ServerName,
    config: McpSchema.ServerConfig,
    directory: string,
    held?: ServerEntry,
  ): Effect.Effect<McpSchema.ServerInfo> =>
    Effect.gen(function* () {
      const toolsList = yield* cachedToolsFor(name, config, directory)

      const status: McpSchema.Status = config.disabled
        ? { status: "disabled" }
        : (held?.status ?? lastStatus.get(name) ?? { status: "idle" })

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
        ...(config.disabled !== undefined && { disabled: config.disabled }),
        ...(config.type === "remote" && { url: config.url }),
        ...(config.type === "local" && { command: [...config.command] }),
      }
    })

  const awaitStartup = Effect.fn("Mcp.awaitStartup")(function* () {
    const now = yield* Clock.currentTimeMillis

    yield* Effect.all(
      Array.from(heldEntries.values()).flatMap((entry) => {
        if (entry.status.status !== "pending" || !entry.attempt) return []
        const remaining = entry.attempt.started + STARTUP_GRACE_MS - now

        return remaining > 0 ? [entry.attempt.settled.await.pipe(Effect.raceFirst(Effect.sleep(remaining)))] : []
      }),
      { concurrency: "unbounded", discard: true },
    )
  })

  const list = Effect.fn("Mcp.list")(function* (
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.ServerInfo>> {
    yield* awaitStartup()
    const dir = directory ?? layout.home
    const configured = yield* loadConfiguredServers(directory)
    const infos: Array<McpSchema.ServerInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || Option.isNone(decoded)) continue
      infos.push(yield* toServerInfo(decoded.value, config, dir, heldEntries.get(rawName)))
    }

    return infos
  })

  const add = Effect.fn("Mcp.add")(function* (
    rawServer: string,
    config: McpSchema.ServerConfig,
  ): Effect.fn.Return<McpSchema.ServerInfo, McpSchema.ConfigError> {
    const name = yield* parseServerName(rawServer)

    yield* reconcileLock.withPermit(
      Effect.gen(function* () {
        const existing = yield* readConfigFile(configPath)
        yield* writeGlobalConfig({ ...existing, [name]: config })
        yield* metadataCache.invalidate(name)
        const oldHeld = heldEntries.get(name)

        if (oldHeld) {
          yield* transition(oldHeld.connection.stop.pipe(locks.withLock(name)))
          heldEntries.delete(name)
        }

        lastStatus.set(name, config.disabled ? { status: "disabled" } : { status: "idle" })
      }),
    )

    return yield* toServerInfo(name, config, layout.home)
  })

  const remove = Effect.fn("Mcp.remove")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, McpSchema.NotFoundError> {
    yield* reconcileLock.withPermit(
      Effect.gen(function* () {
        const existing = yield* readConfigFile(configPath)

        if (!(rawServer in existing)) {
          return yield* new McpSchema.NotFoundError({
            server: rawServer,
            message: `MCP server not found: ${rawServer}`,
          })
        }

        const next = { ...existing }
        delete next[rawServer]
        yield* writeGlobalConfig(next).pipe(Effect.ignore)
        yield* metadataCache.invalidate(rawServer)
        lastStatus.delete(rawServer)
        const held = heldEntries.get(rawServer)

        if (held) {
          yield* transition(held.connection.stop.pipe(locks.withLock(rawServer)))
          heldEntries.delete(rawServer)
        }
      }),
    )
  })

  const connect = Effect.fn("Mcp.connect")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<McpSchema.ServerInfo, McpSchema.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer, directory)
    let entry = heldEntries.get(rawServer)

    if (
      !entry ||
      JSON.stringify(entry.config) !== JSON.stringify(resolved.config) ||
      entry.directory !== resolved.directory
    ) {
      if (entry) {
        yield* transition(entry.connection.stop.pipe(locks.withLock(rawServer)))
      }

      entry = makeEntry(resolved.name, resolved.config, resolved.directory)
      heldEntries.set(rawServer, entry)
    }

    if (!entry.config.disabled && !entry.connection.client) {
      yield* transition(entry.connection.start.pipe(locks.withLock(rawServer)))
    }

    return yield* toServerInfo(entry.name, entry.config, entry.directory, entry)
  })

  const disconnect = Effect.fn("Mcp.disconnect")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, McpSchema.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer)
    const held = heldEntries.get(rawServer)

    if (held) {
      yield* transition(held.connection.stop.pipe(locks.withLock(rawServer)))
      heldEntries.delete(rawServer)
    }

    const nextStatus: McpSchema.Status = resolved.config.disabled ? { status: "disabled" } : { status: "idle" }
    yield* emitStatus(resolved.name, nextStatus)
  })

  const tools = Effect.fn("Mcp.tools")(function* (
    rawServer?: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.ToolInfo>, McpSchema.NotFoundError> {
    if (rawServer !== undefined) {
      const resolved = yield* resolveConfigured(rawServer, directory)
      const cached = yield* cachedToolsFor(resolved.name, resolved.config, resolved.directory)

      if (cached.length > 0 || resolved.config.disabled) return cached

      return yield* withActiveEntry(rawServer, directory, (entry) => Effect.succeed(serverTools(entry)))
    }

    const dir = directory ?? layout.home
    const configured = yield* loadConfiguredServers(directory)
    const all: Array<McpSchema.ToolInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || config.disabled || Option.isNone(decoded)) continue
      const items = yield* cachedToolsFor(decoded.value, config, dir)
      all.push(...items)
    }

    return all
  })

  const search = Effect.fn("Mcp.search")(function* (
    query: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.ToolInfo>> {
    const needle = query.trim().toLowerCase()
    const all = yield* tools(undefined, directory).pipe(Effect.orElseSucceed(() => []))

    if (!needle) return all

    return all.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) ||
        tool.server.toLowerCase().includes(needle) ||
        (tool.description?.toLowerCase().includes(needle) ?? false),
    )
  })

  const describe = Effect.fn("Mcp.describe")(function* (
    rawServer: string,
    toolName: string,
    directory?: string,
  ): Effect.fn.Return<McpSchema.ToolInfo, McpSchema.NotFoundError | McpSchema.ToolNotFoundError> {
    const listItems = yield* tools(rawServer, directory)
    const found = listItems.find((item) => item.name === toolName)

    if (!found) {
      return yield* new McpSchema.ToolNotFoundError({
        server: rawServer,
        tool: toolName,
        message: `MCP tool "${toolName}" not found on server "${rawServer}"`,
      })
    }

    return found
  })

  const call = Effect.fn("Mcp.call")(function* (input: {
    readonly server: string
    readonly tool: string
    readonly args?: Schema.JsonObject | undefined
    readonly directory?: string | undefined
  }): Effect.fn.Return<McpSchema.CallResult, McpSchema.NotFoundError | McpSchema.ToolCallError | McpSchema.AuthError> {
    return yield* withActiveEntry(input.server, input.directory, (entry) =>
      Effect.gen(function* () {
        if (entry.config.disabled) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: input.tool,
            message: `MCP server "${input.server}" is disabled`,
          })
        }

        const client = entry.connection.client

        if (!client) {
          if (entry.status.status === "needs_auth") {
            return yield* new McpSchema.AuthError({
              server: input.server,
              message: entry.status.error,
              ...(entry.status.requiredScope !== undefined && { requiredScope: entry.status.requiredScope }),
            })
          }

          const reason = entry.status.status === "failed" ? entry.status.error : "not connected"

          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: input.tool,
            message: `MCP server "${input.server}" failed to connect: ${reason}`,
          })
        }

        const runCall = () =>
          entry.connection.recovering(client, (liveClient) =>
            liveClient.callTool({ name: input.tool, args: input.args }),
          )

        return yield* runCall().pipe(
          Effect.catchIf(
            (error) => error.message.includes("-32602") || error.message.toLowerCase().includes("unknown tool"),
            () =>
              entry.connection
                .refreshTools()
                .pipe(Effect.andThen(cacheTools(entry)), Effect.ignore, Effect.andThen(runCall())),
          ),
          Effect.mapError(
            (error) =>
              new McpSchema.ToolCallError({
                server: input.server,
                tool: input.tool,
                message: error.message,
              }),
          ),
        )
      }),
    )
  })

  const events = Effect.fn("Mcp.events")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.EventType>, McpSchema.NotFoundError | McpSchema.ToolCallError> {
    return yield* withActiveEntry(rawServer, directory, (entry) =>
      Effect.gen(function* () {
        const client = entry.connection.client

        if (!client) {
          return yield* new McpSchema.ToolCallError({
            server: rawServer,
            tool: "events/list",
            message: `MCP server "${rawServer}" is not connected`,
          })
        }

        if (!client.events) return []

        return yield* client.events.list().pipe(
          Effect.mapError(
            (error) =>
              new McpSchema.ToolCallError({
                server: rawServer,
                tool: "events/list",
                message: error.message,
              }),
          ),
        )
      }),
    )
  })

  const skills = Effect.fn("Mcp.skills")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.SkillEntry>, McpSchema.NotFoundError | McpSchema.ToolCallError> {
    return yield* withActiveEntry(rawServer, directory, (entry) =>
      Effect.gen(function* () {
        const client = entry.connection.client

        if (!client) {
          return yield* new McpSchema.ToolCallError({
            server: rawServer,
            tool: "skills/list",
            message: `MCP server "${rawServer}" is not connected`,
          })
        }

        if (!client.skills) return []

        return yield* client.skills.list().pipe(
          Effect.mapError(
            (error) =>
              new McpSchema.ToolCallError({
                server: rawServer,
                tool: "skills/list",
                message: error.message,
              }),
          ),
        )
      }),
    )
  })

  const read = Effect.fn("Mcp.read")(function* (input: {
    readonly server: string
    readonly uri: string
    readonly directory?: string | undefined
  }): Effect.fn.Return<
    McpSchema.ReadResourceResult,
    McpSchema.NotFoundError | McpSchema.ToolCallError | McpSchema.AuthError
  > {
    return yield* withActiveEntry(input.server, input.directory, (entry) =>
      Effect.gen(function* () {
        if (entry.config.disabled) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "resources/read",
            message: `MCP server "${input.server}" is disabled`,
          })
        }

        const client = entry.connection.client

        if (!client) {
          if (entry.status.status === "needs_auth") {
            return yield* new McpSchema.AuthError({
              server: input.server,
              message: entry.status.error,
              ...(entry.status.requiredScope !== undefined && { requiredScope: entry.status.requiredScope }),
            })
          }

          const reason = entry.status.status === "failed" ? entry.status.error : "not connected"

          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "resources/read",
            message: `MCP server "${input.server}" failed to connect: ${reason}`,
          })
        }

        let expectedDigest: string | undefined

        if (client.skills && input.uri.startsWith("skill://")) {
          const advertisedSkills = yield* client.skills.list().pipe(Effect.orElseSucceed(() => []))

          for (const skill of advertisedSkills) {
            const match = skill.resources.find((resource) => resource.uri === input.uri)

            if (match?.digest !== undefined) {
              expectedDigest = match.digest
              break
            }
          }
        }

        const raw = yield* entry.connection
          .recovering(client, (liveClient) => liveClient.readResource({ uri: input.uri }))
          .pipe(
            Effect.mapError(
              (error) =>
                new McpSchema.ToolCallError({
                  server: input.server,
                  tool: "resources/read",
                  message: error.message,
                }),
            ),
          )

        if (!raw || raw.contents.length === 0) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "resources/read",
            message: `MCP resource not found: ${input.uri}`,
          })
        }

        const contents: Array<McpSchema.ResourceContent> = raw.contents.map((item) => ({
          uri: item.uri,
          ...(item.mimeType !== undefined && { mimeType: item.mimeType }),
          ...("text" in item && item.text !== undefined && { text: item.text }),
          ...("blob" in item && item.blob !== undefined && { blob: item.blob }),
        }))

        if (expectedDigest !== undefined) {
          yield* verifySkillDigest(input.server, input.uri, expectedDigest, contents)
        }

        return { uri: input.uri, contents }
      }),
    )
  })

  const requireRemote = Effect.fn("Mcp.requireRemote")(function* (
    rawServer: string,
  ): Effect.fn.Return<
    { readonly name: McpSchema.ServerName; readonly config: McpSchema.RemoteServerConfig },
    McpSchema.NotFoundError | McpSchema.AuthError
  > {
    const resolved = yield* resolveConfigured(rawServer)

    if (resolved.config.type !== "remote") {
      return yield* new McpSchema.AuthError({
        server: rawServer,
        message: `MCP server "${rawServer}" is a local server and does not use OAuth`,
      })
    }

    return { name: resolved.name, config: resolved.config }
  })

  const authStart = Effect.fn("Mcp.authStart")(function* (
    rawServer: string,
  ): Effect.fn.Return<McpSchema.AuthStartResult, McpSchema.NotFoundError | McpSchema.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)

    return yield* authManager
      .authStart(name, config)
      .pipe(Effect.mapError((error) => new McpSchema.AuthError({ server: rawServer, message: error.message })))
  })

  const authComplete = Effect.fn("Mcp.authComplete")(function* (
    rawServer: string,
    redirectUrlOrCode: string,
    state?: string,
  ): Effect.fn.Return<McpSchema.AuthCompleteResult, McpSchema.NotFoundError | McpSchema.AuthError> {
    yield* requireRemote(rawServer)

    return yield* authManager
      .authComplete(rawServer, redirectUrlOrCode, state)
      .pipe(Effect.mapError((error) => new McpSchema.AuthError({ server: rawServer, message: error.message })))
  })

  const authSetToken = Effect.fn("Mcp.authSetToken")(function* (
    rawServer: string,
    input: {
      readonly accessToken: string
      readonly refreshToken?: string | undefined
      readonly expiresAt?: number | undefined
      readonly scope?: string | undefined
    },
  ): Effect.fn.Return<McpSchema.AuthCompleteResult, McpSchema.NotFoundError | McpSchema.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)

    return yield* authManager
      .setToken(name, config, input.accessToken, input.refreshToken, input.expiresAt, input.scope)
      .pipe(Effect.mapError((error) => new McpSchema.AuthError({ server: rawServer, message: error.message })))
  })

  const authLogout = Effect.fn("Mcp.authLogout")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, McpSchema.NotFoundError | McpSchema.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)
    yield* authManager
      .logout(name, config)
      .pipe(Effect.mapError((error) => new McpSchema.AuthError({ server: rawServer, message: error.message })))
    yield* metadataCache.invalidate(name)
  })

  return CoreMcp.Service.of({
    list,
    add,
    remove,
    connect,
    disconnect,
    tools,
    search,
    describe,
    call,
    events,
    skills,
    read,
    authStart,
    authComplete,
    authSetToken,
    authLogout,
  })
})

export const layer = (options?: Options) => Layer.effect(CoreMcp.Service, make(options))

export const node = LayerNode.make({
  service: CoreMcp.Service,
  layer: layer(),
  deps: [
    PlatformNode.layout,
    PlatformNode.fileSystem,
    PlatformNode.path,
    PlatformNode.childProcessSpawner,
    PlatformNode.fetch,
    Bus.node,
    McpPool.node,
    McpVault.node,
    McpMetadataCache.node,
  ],
})
