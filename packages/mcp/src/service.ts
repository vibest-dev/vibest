import fs from "node:fs"
import path from "node:path"

import { Mcp } from "@vibest/schema/mcp"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { Clock, Effect, Exit, FiberSet, Option, Schema, Scope } from "effect"

import type { McpClient } from "./client.ts"
import { McpMetadataCache } from "./metadata-cache.ts"
import { McpOAuth } from "./oauth.ts"
import { McpPool } from "./pool.ts"
import { McpSkillSync } from "./skill-sync.ts"
import { McpStdio } from "./stdio.ts"
import { renderToolSignature } from "./ts-shape.ts"
import { McpVault } from "./vault.ts"

export * as McpRuntime from "./service.ts"

const decodeConfigFile = Schema.decodeUnknownOption(Mcp.ConfigFile)
const decodeServerName = Schema.decodeUnknownOption(Mcp.ServerName)

const parseServerName = (raw: string): Effect.Effect<Mcp.ServerName, Mcp.ConfigError> => {
  const decoded = decodeServerName(raw)

  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new Mcp.ConfigError({ message: `Invalid MCP server name: ${raw}` }))
}

const toolAllowed = (toolName: string, config: Mcp.ServerConfig): boolean => {
  if (config.includeTools && config.includeTools.length > 0 && !config.includeTools.includes(toolName)) {
    return false
  }

  if (config.excludeTools && config.excludeTools.includes(toolName)) {
    return false
  }

  return true
}

const toToolInfo = (server: Mcp.ServerName, tool: McpClient.Tool): Mcp.ToolInfo => ({
  server,
  name: tool.name,
  ...(tool.title !== undefined && { title: tool.title }),
  ...(tool.description !== undefined && { description: tool.description }),
  signature: renderToolSignature(tool.inputSchema),
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
  ...(tool.annotations !== undefined && { annotations: tool.annotations }),
})

interface ServerEntry {
  readonly name: Mcp.ServerName
  readonly config: Mcp.ServerConfig
  status: Mcp.Status
  readonly connection: McpPool.PooledConnection
  readonly directory: string
}

export interface EventCallbacks {
  readonly onStatusChanged?: ((server: Mcp.ServerName, status: Mcp.Status) => Effect.Effect<void>) | undefined
  readonly onToolsChanged?: ((server: Mcp.ServerName) => Effect.Effect<void>) | undefined
  readonly onResourcesChanged?: ((server: Mcp.ServerName) => Effect.Effect<void>) | undefined
}

export interface Options {
  readonly vibestHome: string
  readonly events?: EventCallbacks | undefined
}

export const make = Effect.fn("McpRuntime.make")(function* (options: Options) {
  const rootScope = yield* Effect.scope
  const serverScope = yield* Scope.fork(rootScope, "parallel")
  const callbacks = yield* FiberSet.makeRuntime<never, void, never>()
  const fork = yield* FiberSet.makeRuntime<never, void, never>()
  const pool = yield* McpPool.make()
  const vault = McpVault.make({ vibestHome: options.vibestHome })
  const authManager = McpOAuth.makeAuthManager({ vault })
  const metadataCache = McpMetadataCache.make(options.vibestHome)
  const locks = KeyedMutex.makeUnsafe<string>()
  const configPath = path.join(options.vibestHome, "mcp.json")
  const entries = new Map<string, ServerEntry>()

  yield* Scope.addFinalizer(
    rootScope,
    Effect.gen(function* () {
      yield* authManager.closeAll.pipe(Effect.ignore)
      yield* pool.closeAll.pipe(Effect.ignore)
      yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore)
    }),
  )

  const emitStatus = (server: Mcp.ServerName, status: Mcp.Status) =>
    options.events?.onStatusChanged ? options.events.onStatusChanged(server, status) : Effect.void

  const emitTools = (server: Mcp.ServerName) =>
    options.events?.onToolsChanged ? options.events.onToolsChanged(server) : Effect.void

  const emitResources = (server: Mcp.ServerName) =>
    options.events?.onResourcesChanged ? options.events.onResourcesChanged(server) : Effect.void

  const readConfigFile = (filePath: string): Record<string, Mcp.ServerConfig> => {
    if (!fs.existsSync(filePath)) return {}

    try {
      const decoded = decodeConfigFile(JSON.parse(fs.readFileSync(filePath, "utf8")))

      return Option.isSome(decoded) ? { ...decoded.value.mcpServers } : {}
    } catch {
      return {}
    }
  }

  const writeGlobalConfig = (servers: Readonly<Record<string, Mcp.ServerConfig>>): void => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2), "utf8")
    fs.renameSync(tmp, configPath)
  }

  const loadConfiguredServers = (directory?: string) => {
    const globalServers = readConfigFile(configPath)

    if (!directory) return globalServers
    const projectConfigPath = path.join(directory, ".mcp.json")
    const projectServers = readConfigFile(projectConfigPath)

    return { ...globalServers, ...projectServers }
  }

  const fingerprintFor = (config: Mcp.ServerConfig, directory: string, credentialId?: string): string =>
    McpMetadataCache.computeFingerprint({
      config,
      ...(config.type === "local" && { resolvedCwd: McpStdio.resolveCwd(directory, config.cwd) }),
      ...(credentialId !== undefined && { credentialId }),
    })

  const makeEntry = (name: Mcp.ServerName, config: Mcp.ServerConfig, directory: string): ServerEntry => {
    const entry: ServerEntry = {
      name,
      config,
      directory,
      status: config.disabled ? { status: "disabled" } : { status: "idle" },
      connection: pool.connection({
        name,
        config: config.pool !== false && config.protocol === undefined ? { ...config, protocol: "auto" } : config,
        directory,
        vibestHome: options.vibestHome,
        mcpEvents: true,
        authProvider: Effect.suspend(() => {
          if (config.type !== "remote") return Effect.succeed(undefined)
          const fetchFn = McpOAuth.createScopedFetch({ serverUrl: config.url, customHeaders: config.headers })

          return Effect.succeed(McpOAuth.connectProvider({ server: name, config, vault, fetchFn }))
        }),
        select: Effect.gen(function* () {
          if (config.type === "remote") {
            const cred = yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined))
            const fetchFn = McpOAuth.createScopedFetch({ serverUrl: config.url, customHeaders: config.headers })

            return {
              key: McpPool.poolKey({ config, credentialId: cred?.id, mcpEvents: true }),
              authProvider: Effect.succeed(McpOAuth.connectProvider({ server: name, config, vault, fetchFn })),
            }
          }

          const resolvedCwd = McpStdio.resolveCwd(directory, config.cwd)

          return {
            key: McpPool.poolKey({ config, cwd: resolvedCwd, mcpEvents: true }),
            authProvider: Effect.succeed(undefined),
          }
        }),
        scope: serverScope,
        lock: locks.withLock(name),
        callbacks: (effect) => {
          callbacks(effect)
        },
        fork: (effect) => {
          fork(effect)
        },
        events: {
          connecting: Effect.gen(function* () {
            entry.status = { status: "pending" }
            yield* emitStatus(name, entry.status)
          }),
          connected: Effect.gen(function* () {
            entry.status = { status: "connected" }
            const now = yield* Clock.currentTimeMillis

            const filtered = (entry.connection.tools ?? [])
              .filter((tool) => toolAllowed(tool.name, config))
              .map((tool) => toToolInfo(name, tool))

            const credId =
              config.type === "remote"
                ? (yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
                : undefined

            metadataCache.set(name, config, {
              fingerprint: fingerprintFor(config, directory, credId),
              cachedAt: now,
              ...(entry.connection.client?.title !== undefined && { title: entry.connection.client.title }),
              ...(entry.connection.client?.instructions !== undefined && {
                instructions: entry.connection.client.instructions,
              }),
              tools: filtered,
            })

            yield* emitTools(name)
            yield* emitResources(name)
            yield* emitStatus(name, entry.status)
          }),
          failed: (failure) =>
            Effect.gen(function* () {
              entry.status = failure
              yield* emitStatus(name, entry.status)
            }),
          settled: Effect.void,
          closed: (reason) =>
            Effect.gen(function* () {
              entry.status = { status: "failed", error: reason }
              yield* emitStatus(name, entry.status)
            }),
          changed: (kind) =>
            Effect.gen(function* () {
              if (kind === "tools") {
                const now = yield* Clock.currentTimeMillis

                const filtered = (entry.connection.tools ?? [])
                  .filter((tool) => toolAllowed(tool.name, config))
                  .map((tool) => toToolInfo(name, tool))

                if (filtered.length > 0) {
                  const credId =
                    config.type === "remote"
                      ? (yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
                      : undefined

                  metadataCache.set(name, config, {
                    fingerprint: fingerprintFor(config, directory, credId),
                    cachedAt: now,
                    ...(entry.connection.client?.title !== undefined && { title: entry.connection.client.title }),
                    ...(entry.connection.client?.instructions !== undefined && {
                      instructions: entry.connection.client.instructions,
                    }),
                    tools: filtered,
                  })
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

  const ensureEntry = Effect.fn("McpRuntime.ensureEntry")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<ServerEntry, Mcp.NotFoundError> {
    const dir = directory ?? options.vibestHome
    const configured = loadConfiguredServers(directory)
    const config = configured[rawServer]

    if (!config) {
      return yield* new Mcp.NotFoundError({ server: rawServer, message: `MCP server not found: ${rawServer}` })
    }

    const decoded = decodeServerName(rawServer)

    if (Option.isNone(decoded)) {
      return yield* new Mcp.NotFoundError({ server: rawServer, message: `Invalid MCP server name: ${rawServer}` })
    }

    const existing = entries.get(rawServer)

    if (existing && JSON.stringify(existing.config) === JSON.stringify(config) && existing.directory === dir) {
      return existing
    }

    if (existing) {
      yield* existing.connection.stop.pipe(locks.withLock(rawServer))
    }

    const created = makeEntry(decoded.value, config, dir)
    entries.set(rawServer, created)

    return created
  })

  const cachedOrLiveTools = (entry: ServerEntry): Effect.Effect<ReadonlyArray<Mcp.ToolInfo>> =>
    Effect.gen(function* () {
      if (entry.connection.tools) {
        return entry.connection.tools
          .filter((tool) => toolAllowed(tool.name, entry.config))
          .map((tool) => toToolInfo(entry.name, tool))
      }

      const credId =
        entry.config.type === "remote"
          ? (yield* vault.get(entry.name, entry.config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
          : undefined

      const cached = metadataCache.get(entry.name, fingerprintFor(entry.config, entry.directory, credId))

      return cached ? cached.tools : []
    })

  const toServerInfo = (entry: ServerEntry): Effect.Effect<Mcp.ServerInfo> =>
    Effect.gen(function* () {
      const toolsList = yield* cachedOrLiveTools(entry)

      return {
        name: entry.name,
        type: entry.config.type,
        exposure: entry.config.exposure ?? "skill",
        status: entry.status,
        ...(entry.connection.client?.title !== undefined && { title: entry.connection.client.title }),
        ...(entry.connection.client?.instructions !== undefined && {
          instructions: entry.connection.client.instructions,
        }),
        toolCount: toolsList.length,
        ...(entry.config.pool !== undefined && { pooled: entry.config.pool }),
        ...(entry.config.disabled !== undefined && { disabled: entry.config.disabled }),
        ...(entry.config.type === "remote" && { url: entry.config.url }),
        ...(entry.config.type === "local" && { command: [...entry.config.command] }),
      }
    })

  const list = Effect.fn("McpRuntime.list")(function* (
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.ServerInfo>> {
    const configured = loadConfiguredServers(directory)
    const infos: Array<Mcp.ServerInfo> = []

    for (const name of Object.keys(configured).toSorted()) {
      const entry = yield* ensureEntry(name, directory).pipe(Effect.orElseSucceed(() => undefined))

      if (entry) infos.push(yield* toServerInfo(entry))
    }

    return infos
  })

  const add = Effect.fn("McpRuntime.add")(function* (
    rawServer: string,
    config: Mcp.ServerConfig,
  ): Effect.fn.Return<Mcp.ServerInfo, Mcp.ConfigError> {
    const name = yield* parseServerName(rawServer)
    const existing = readConfigFile(configPath)
    writeGlobalConfig({ ...existing, [name]: config })
    metadataCache.invalidate(name)
    const oldEntry = entries.get(name)

    if (oldEntry) {
      yield* oldEntry.connection.stop.pipe(locks.withLock(name))
    }

    const entry = makeEntry(name, config, options.vibestHome)
    entries.set(name, entry)

    return yield* toServerInfo(entry)
  })

  const remove = Effect.fn("McpRuntime.remove")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, Mcp.NotFoundError> {
    const existing = readConfigFile(configPath)

    if (!(rawServer in existing)) {
      return yield* new Mcp.NotFoundError({ server: rawServer, message: `MCP server not found: ${rawServer}` })
    }

    const next = { ...existing }
    delete next[rawServer]
    writeGlobalConfig(next)
    metadataCache.invalidate(rawServer)
    const entry = entries.get(rawServer)

    if (entry) {
      yield* entry.connection.stop.pipe(locks.withLock(rawServer))
      entries.delete(rawServer)
    }
  })

  const connect = Effect.fn("McpRuntime.connect")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<Mcp.ServerInfo, Mcp.NotFoundError> {
    const entry = yield* ensureEntry(rawServer, directory)

    if (!entry.config.disabled && !entry.connection.client) {
      yield* entry.connection.start.pipe(locks.withLock(rawServer))
    }

    return yield* toServerInfo(entry)
  })

  const disconnect = Effect.fn("McpRuntime.disconnect")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, Mcp.NotFoundError> {
    const entry = yield* ensureEntry(rawServer)
    yield* entry.connection.stop.pipe(locks.withLock(rawServer))
    entry.status = entry.config.disabled ? { status: "disabled" } : { status: "idle" }
    yield* emitStatus(entry.name, entry.status)
  })

  const tools = Effect.fn("McpRuntime.tools")(function* (
    rawServer?: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.ToolInfo>, Mcp.NotFoundError> {
    if (rawServer !== undefined) {
      const entry = yield* ensureEntry(rawServer, directory)
      const cached = yield* cachedOrLiveTools(entry)

      if (cached.length > 0 || entry.config.disabled) return cached
      yield* entry.connection.start.pipe(locks.withLock(rawServer))

      return yield* cachedOrLiveTools(entry)
    }

    const configured = loadConfiguredServers(directory)
    const all: Array<Mcp.ToolInfo> = []

    for (const name of Object.keys(configured).toSorted()) {
      const entry = yield* ensureEntry(name, directory).pipe(Effect.orElseSucceed(() => undefined))

      if (!entry || entry.config.disabled) continue
      const items = yield* cachedOrLiveTools(entry)
      all.push(...items)
    }

    return all
  })

  const search = Effect.fn("McpRuntime.search")(function* (
    query: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.ToolInfo>> {
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

  const describe = Effect.fn("McpRuntime.describe")(function* (
    rawServer: string,
    toolName: string,
    directory?: string,
  ): Effect.fn.Return<Mcp.ToolInfo, Mcp.NotFoundError | Mcp.ToolNotFoundError> {
    const listItems = yield* tools(rawServer, directory)
    const found = listItems.find((item) => item.name === toolName)

    if (!found) {
      return yield* new Mcp.ToolNotFoundError({
        server: rawServer,
        tool: toolName,
        message: `MCP tool "${toolName}" not found on server "${rawServer}"`,
      })
    }

    return found
  })

  const call = Effect.fn("McpRuntime.call")(function* (input: {
    readonly server: string
    readonly tool: string
    readonly args?: Schema.JsonObject | undefined
    readonly directory?: string | undefined
    readonly maxBytes?: number | undefined
    readonly scratchpadDir?: string | undefined
  }): Effect.fn.Return<Mcp.CallResult, Mcp.NotFoundError | Mcp.ToolCallError | Mcp.AuthError> {
    const entry = yield* ensureEntry(input.server, input.directory)

    if (entry.config.disabled) {
      return yield* new Mcp.ToolCallError({
        server: input.server,
        tool: input.tool,
        message: `MCP server "${input.server}" is disabled`,
      })
    }

    if (!entry.connection.client) {
      yield* entry.connection.start.pipe(locks.withLock(input.server))
    }

    const client = entry.connection.client

    if (!client) {
      if (entry.status.status === "needs_auth") {
        return yield* new Mcp.AuthError({
          server: input.server,
          message: entry.status.error,
          ...(entry.status.requiredScope !== undefined && { requiredScope: entry.status.requiredScope }),
        })
      }

      const reason = entry.status.status === "failed" ? entry.status.error : "not connected"

      return yield* new Mcp.ToolCallError({
        server: input.server,
        tool: input.tool,
        message: `MCP server "${input.server}" failed to connect: ${reason}`,
      })
    }

    const runCall = () =>
      entry.connection.recovering(client, (liveClient) => liveClient.callTool({ name: input.tool, args: input.args }))

    const rawResult = yield* runCall().pipe(
      Effect.catchIf(
        (error) => error.message.includes("-32602") || error.message.toLowerCase().includes("unknown tool"),
        () => client.tools().pipe(Effect.ignore, Effect.andThen(runCall())),
      ),
      Effect.mapError(
        (error) =>
          new Mcp.ToolCallError({
            server: input.server,
            tool: input.tool,
            message: error.message,
          }),
      ),
    )

    return McpSkillSync.guardCallResult({
      server: input.server,
      tool: input.tool,
      result: rawResult,
      ...(input.maxBytes !== undefined && { maxBytes: input.maxBytes }),
      ...(input.scratchpadDir !== undefined && { scratchpadDir: input.scratchpadDir }),
    })
  })

  const events = Effect.fn("McpRuntime.events")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.EventType>, Mcp.NotFoundError | Mcp.ToolCallError> {
    const entry = yield* ensureEntry(rawServer, directory)

    if (!entry.connection.client) {
      yield* entry.connection.start.pipe(locks.withLock(rawServer))
    }

    const client = entry.connection.client

    if (!client) {
      return yield* new Mcp.ToolCallError({
        server: rawServer,
        tool: "events/list",
        message: `MCP server "${rawServer}" is not connected`,
      })
    }

    if (!client.events) return []

    return yield* client.events.list().pipe(
      Effect.mapError(
        (error) =>
          new Mcp.ToolCallError({
            server: rawServer,
            tool: "events/list",
            message: error.message,
          }),
      ),
    )
  })

  const syncSkills = Effect.fn("McpRuntime.syncSkills")(function* (
    projectDir?: string,
  ): Effect.fn.Return<Mcp.SkillSyncResult> {
    const configured = loadConfiguredServers(projectDir)

    const items: Array<{
      readonly server: Mcp.ServerName
      readonly exposure: Mcp.ExposureMode
      readonly disabled?: boolean | undefined
      readonly title?: string | undefined
      readonly instructions?: string | undefined
      readonly tools: ReadonlyArray<Mcp.ToolInfo>
    }> = []

    for (const name of Object.keys(configured).toSorted()) {
      const entry = yield* ensureEntry(name, projectDir).pipe(Effect.orElseSucceed(() => undefined))

      if (!entry) continue

      if (!entry.config.disabled && !entry.connection.client && (entry.config.exposure ?? "skill") === "skill") {
        yield* entry.connection.start.pipe(locks.withLock(name), Effect.ignore)
      }

      const listedTools = yield* cachedOrLiveTools(entry)

      items.push({
        server: entry.name,
        exposure: entry.config.exposure ?? "skill",
        disabled: entry.config.disabled,
        title: entry.connection.client?.title,
        instructions: entry.connection.client?.instructions,
        tools: listedTools,
      })
    }

    const skillsRoot = projectDir ? path.join(projectDir, ".agents", "skills") : path.join(options.vibestHome, "skills")

    return McpSkillSync.syncSkillsToDirectory({ skillsRoot, servers: items })
  })

  const requireRemote = Effect.fn("McpRuntime.requireRemote")(function* (
    rawServer: string,
  ): Effect.fn.Return<
    { readonly name: Mcp.ServerName; readonly config: Mcp.RemoteServerConfig },
    Mcp.NotFoundError | Mcp.AuthError
  > {
    const entry = yield* ensureEntry(rawServer)

    if (entry.config.type !== "remote") {
      return yield* new Mcp.AuthError({
        server: rawServer,
        message: `MCP server "${rawServer}" is a local server and does not use OAuth`,
      })
    }

    return { name: entry.name, config: entry.config }
  })

  const authStart = Effect.fn("McpRuntime.authStart")(function* (
    rawServer: string,
  ): Effect.fn.Return<Mcp.AuthStartResult, Mcp.NotFoundError | Mcp.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)

    return yield* authManager
      .authStart(name, config)
      .pipe(Effect.mapError((error) => new Mcp.AuthError({ server: rawServer, message: error.message })))
  })

  const authComplete = Effect.fn("McpRuntime.authComplete")(function* (
    rawServer: string,
    redirectUrlOrCode: string,
    state?: string,
  ): Effect.fn.Return<Mcp.AuthCompleteResult, Mcp.NotFoundError | Mcp.AuthError> {
    yield* requireRemote(rawServer)

    return yield* authManager
      .authComplete(rawServer, redirectUrlOrCode, state)
      .pipe(Effect.mapError((error) => new Mcp.AuthError({ server: rawServer, message: error.message })))
  })

  const authSetToken = Effect.fn("McpRuntime.authSetToken")(function* (
    rawServer: string,
    input: {
      readonly accessToken: string
      readonly refreshToken?: string | undefined
      readonly expiresAt?: number | undefined
      readonly scope?: string | undefined
    },
  ): Effect.fn.Return<Mcp.AuthCompleteResult, Mcp.NotFoundError | Mcp.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)

    return yield* authManager
      .setToken(name, config, input.accessToken, input.refreshToken, input.expiresAt, input.scope)
      .pipe(Effect.mapError((error) => new Mcp.AuthError({ server: rawServer, message: error.message })))
  })

  const authLogout = Effect.fn("McpRuntime.authLogout")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, Mcp.NotFoundError | Mcp.AuthError> {
    const { name, config } = yield* requireRemote(rawServer)
    yield* authManager
      .logout(name, config)
      .pipe(Effect.mapError((error) => new Mcp.AuthError({ server: rawServer, message: error.message })))
    metadataCache.invalidate(name)
  })

  return {
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
    syncSkills,
    authStart,
    authComplete,
    authSetToken,
    authLogout,
  }
})
