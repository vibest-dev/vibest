import fs from "node:fs"
import path from "node:path"

import type { AuthProvider } from "@modelcontextprotocol/client"
import { Mcp } from "@vibest/schema/mcp"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { Clock, Effect, Exit, FiberSet, Option, Schema, Scope } from "effect"

import type { McpClient } from "./client.ts"
import { writeAtomicFile } from "./fs-util.ts"
import { McpMetadataCache } from "./metadata-cache.ts"
import { McpOAuth } from "./oauth.ts"
import { McpPool } from "./pool.ts"
import { McpSecrets } from "./secrets.ts"
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
  const heldEntries = new Map<string, ServerEntry>()
  const lastStatus = new Map<string, Mcp.Status>()

  yield* Scope.addFinalizer(
    rootScope,
    Effect.gen(function* () {
      yield* authManager.closeAll.pipe(Effect.ignore)
      yield* pool.closeAll.pipe(Effect.ignore)
      yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore)
    }),
  )

  const emitStatus = (server: Mcp.ServerName, status: Mcp.Status) =>
    Effect.gen(function* () {
      lastStatus.set(server, status)

      if (options.events?.onStatusChanged) {
        yield* options.events.onStatusChanged(server, status)
      }
    })

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
    writeAtomicFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2))
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

  const makeAuthProvider = (name: Mcp.ServerName, config: Mcp.ServerConfig): Effect.Effect<AuthProvider | undefined> =>
    Effect.gen(function* () {
      if (config.type !== "remote") return undefined

      const resolvedHeaders = yield* McpSecrets.resolveRecord(config.headers, `${name}.headers`).pipe(
        Effect.orElseSucceed(() => config.headers),
      )

      const fetchFn = McpOAuth.createScopedFetch({ serverUrl: config.url, customHeaders: resolvedHeaders })

      return McpOAuth.connectProvider({ server: name, config, vault, fetchFn })
    })

  const cacheTools = (
    name: Mcp.ServerName,
    config: Mcp.ServerConfig,
    directory: string,
    conn: McpPool.PooledConnection,
  ): Effect.Effect<ReadonlyArray<Mcp.ToolInfo>> =>
    Effect.gen(function* () {
      const filtered = (conn.tools ?? [])
        .filter((tool) => toolAllowed(tool.name, config))
        .map((tool) => toToolInfo(name, tool))

      const now = yield* Clock.currentTimeMillis

      const credId =
        config.type === "remote"
          ? (yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
          : undefined

      metadataCache.set(name, config, {
        fingerprint: fingerprintFor(config, directory, credId),
        cachedAt: now,
        ...(conn.toolsMeta?.cacheScope !== undefined && { cacheScope: conn.toolsMeta.cacheScope }),
        ...(conn.toolsMeta?.ttlMs !== undefined && { ttlMs: conn.toolsMeta.ttlMs }),
        ...(conn.client?.title !== undefined && { title: conn.client.title }),
        ...(conn.client?.instructions !== undefined && { instructions: conn.client.instructions }),
        tools: filtered,
      })

      return filtered
    })

  const createEntry = (name: Mcp.ServerName, config: Mcp.ServerConfig, directory: string): ServerEntry => {
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
        authProvider: makeAuthProvider(name, config),
        select: Effect.gen(function* () {
          if (config.type === "remote") {
            const cred = yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined))

            return {
              key: McpPool.poolKey({ config, credentialId: cred?.id, mcpEvents: true }),
              authProvider: makeAuthProvider(name, config),
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
            yield* cacheTools(name, config, directory, entry.connection)
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
                if (entry.connection.tools !== undefined) {
                  yield* cacheTools(name, config, directory, entry.connection)
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

  const resolveConfigured = Effect.fn("McpRuntime.resolveConfigured")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<
    { readonly name: Mcp.ServerName; readonly config: Mcp.ServerConfig; readonly directory: string },
    Mcp.NotFoundError
  > {
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

    return { name: decoded.value, config, directory: dir }
  })

  const withActiveEntry = <A, E>(
    rawServer: string,
    directory: string | undefined,
    run: (entry: ServerEntry) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Mcp.NotFoundError> =>
    Effect.gen(function* () {
      const resolved = yield* resolveConfigured(rawServer, directory)
      const held = heldEntries.get(rawServer)

      if (
        held &&
        JSON.stringify(held.config) === JSON.stringify(resolved.config) &&
        held.directory === resolved.directory
      ) {
        if (!held.config.disabled && !held.connection.client) {
          yield* held.connection.start.pipe(locks.withLock(rawServer))
        }

        return yield* run(held)
      }

      return yield* Effect.scoped(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const ephemeral = createEntry(resolved.name, resolved.config, resolved.directory)

            if (!ephemeral.config.disabled) {
              yield* ephemeral.connection.start.pipe(locks.withLock(rawServer))
            }

            return ephemeral
          }),
          (ephemeral) =>
            ephemeral.connection.stop.pipe(
              locks.withLock(rawServer),
              Effect.andThen(
                Effect.sync(() => {
                  if (!heldEntries.has(rawServer) && !ephemeral.config.disabled) {
                    lastStatus.set(rawServer, { status: "idle" })
                  }
                }),
              ),
              Effect.ignore,
            ),
        ).pipe(Effect.flatMap(run)),
      )
    })

  const cachedToolsFor = (
    name: Mcp.ServerName,
    config: Mcp.ServerConfig,
    directory: string,
  ): Effect.Effect<ReadonlyArray<Mcp.ToolInfo>> =>
    Effect.gen(function* () {
      const held = heldEntries.get(name)

      if (held?.connection.tools) {
        return held.connection.tools
          .filter((tool) => toolAllowed(tool.name, config))
          .map((tool) => toToolInfo(name, tool))
      }

      const credId =
        config.type === "remote"
          ? (yield* vault.get(name, config.url).pipe(Effect.orElseSucceed(() => undefined)))?.id
          : undefined

      const cached = metadataCache.get(name, fingerprintFor(config, directory, credId))

      return cached ? cached.tools : []
    })

  const toServerInfo = (
    name: Mcp.ServerName,
    config: Mcp.ServerConfig,
    directory: string,
    held?: ServerEntry,
  ): Effect.Effect<Mcp.ServerInfo> =>
    Effect.gen(function* () {
      const toolsList = yield* cachedToolsFor(name, config, directory)

      const status: Mcp.Status = config.disabled
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
        toolCount: toolsList.length,
        ...(config.pool !== undefined && { pooled: config.pool }),
        ...(config.disabled !== undefined && { disabled: config.disabled }),
        ...(config.type === "remote" && { url: config.url }),
        ...(config.type === "local" && { command: [...config.command] }),
      }
    })

  const list = Effect.fn("McpRuntime.list")(function* (
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.ServerInfo>> {
    const dir = directory ?? options.vibestHome
    const configured = loadConfiguredServers(directory)
    const infos: Array<Mcp.ServerInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || Option.isNone(decoded)) continue
      infos.push(yield* toServerInfo(decoded.value, config, dir, heldEntries.get(rawName)))
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
    const oldHeld = heldEntries.get(name)

    if (oldHeld) {
      yield* oldHeld.connection.stop.pipe(locks.withLock(name))
      heldEntries.delete(name)
    }

    lastStatus.set(name, config.disabled ? { status: "disabled" } : { status: "idle" })

    return yield* toServerInfo(name, config, options.vibestHome)
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
    lastStatus.delete(rawServer)
    const held = heldEntries.get(rawServer)

    if (held) {
      yield* held.connection.stop.pipe(locks.withLock(rawServer))
      heldEntries.delete(rawServer)
    }
  })

  const connect = Effect.fn("McpRuntime.connect")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<Mcp.ServerInfo, Mcp.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer, directory)
    let entry = heldEntries.get(rawServer)

    if (
      !entry ||
      JSON.stringify(entry.config) !== JSON.stringify(resolved.config) ||
      entry.directory !== resolved.directory
    ) {
      if (entry) {
        yield* entry.connection.stop.pipe(locks.withLock(rawServer))
      }

      entry = createEntry(resolved.name, resolved.config, resolved.directory)
      heldEntries.set(rawServer, entry)
    }

    if (!entry.config.disabled && !entry.connection.client) {
      yield* entry.connection.start.pipe(locks.withLock(rawServer))
    }

    return yield* toServerInfo(entry.name, entry.config, entry.directory, entry)
  })

  const disconnect = Effect.fn("McpRuntime.disconnect")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, Mcp.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer)
    const held = heldEntries.get(rawServer)

    if (held) {
      yield* held.connection.stop.pipe(locks.withLock(rawServer))
      heldEntries.delete(rawServer)
    }

    const nextStatus: Mcp.Status = resolved.config.disabled ? { status: "disabled" } : { status: "idle" }
    yield* emitStatus(resolved.name, nextStatus)
  })

  const tools = Effect.fn("McpRuntime.tools")(function* (
    rawServer?: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.ToolInfo>, Mcp.NotFoundError> {
    if (rawServer !== undefined) {
      const resolved = yield* resolveConfigured(rawServer, directory)
      const cached = yield* cachedToolsFor(resolved.name, resolved.config, resolved.directory)

      if (cached.length > 0 || resolved.config.disabled) return cached

      return yield* withActiveEntry(rawServer, directory, (entry) =>
        Effect.succeed(
          (entry.connection.tools ?? [])
            .filter((tool) => toolAllowed(tool.name, entry.config))
            .map((tool) => toToolInfo(entry.name, tool)),
        ),
      )
    }

    const dir = directory ?? options.vibestHome
    const configured = loadConfiguredServers(directory)
    const all: Array<Mcp.ToolInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || config.disabled || Option.isNone(decoded)) continue
      const items = yield* cachedToolsFor(decoded.value, config, dir)
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
    return yield* withActiveEntry(input.server, input.directory, (entry) =>
      Effect.gen(function* () {
        if (entry.config.disabled) {
          return yield* new Mcp.ToolCallError({
            server: input.server,
            tool: input.tool,
            message: `MCP server "${input.server}" is disabled`,
          })
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
          entry.connection.recovering(client, (liveClient) =>
            liveClient.callTool({ name: input.tool, args: input.args }),
          )

        const rawResult = yield* runCall().pipe(
          Effect.catchIf(
            (error) => error.message.includes("-32602") || error.message.toLowerCase().includes("unknown tool"),
            () =>
              entry.connection
                .refreshTools()
                .pipe(
                  Effect.andThen(cacheTools(entry.name, entry.config, entry.directory, entry.connection)),
                  Effect.ignore,
                  Effect.andThen(runCall()),
                ),
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
      }),
    )
  })

  const events = Effect.fn("McpRuntime.events")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<Mcp.EventType>, Mcp.NotFoundError | Mcp.ToolCallError> {
    return yield* withActiveEntry(rawServer, directory, (entry) =>
      Effect.gen(function* () {
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
      }),
    )
  })

  const syncSkills = Effect.fn("McpRuntime.syncSkills")(function* (
    projectDir?: string,
  ): Effect.fn.Return<Mcp.SkillSyncResult> {
    const dir = projectDir ?? options.vibestHome
    const configured = loadConfiguredServers(projectDir)

    const items: Array<{
      readonly server: Mcp.ServerName
      readonly exposure: Mcp.ExposureMode
      readonly disabled?: boolean | undefined
      readonly title?: string | undefined
      readonly instructions?: string | undefined
      readonly tools: ReadonlyArray<Mcp.ToolInfo>
    }> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || Option.isNone(decoded)) continue
      const exposure = config.exposure ?? "skill"

      if (!config.disabled && exposure === "skill") {
        const listed = yield* withActiveEntry(rawName, projectDir, (entry) =>
          Effect.succeed({
            title: entry.connection.client?.title,
            instructions: entry.connection.client?.instructions,
            tools: (entry.connection.tools ?? [])
              .filter((tool) => toolAllowed(tool.name, entry.config))
              .map((tool) => toToolInfo(entry.name, tool)),
          }),
        ).pipe(
          Effect.orElseSucceed(() => ({
            title: undefined,
            instructions: undefined,
            tools: [] satisfies ReadonlyArray<Mcp.ToolInfo>,
          })),
        )

        const fallbackTools = listed.tools.length > 0 ? listed.tools : yield* cachedToolsFor(decoded.value, config, dir)

        items.push({
          server: decoded.value,
          exposure,
          disabled: config.disabled,
          title: listed.title,
          instructions: listed.instructions,
          tools: fallbackTools,
        })
      } else {
        items.push({
          server: decoded.value,
          exposure,
          disabled: config.disabled,
          tools: yield* cachedToolsFor(decoded.value, config, dir),
        })
      }
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
    const resolved = yield* resolveConfigured(rawServer)

    if (resolved.config.type !== "remote") {
      return yield* new Mcp.AuthError({
        server: rawServer,
        message: `MCP server "${rawServer}" is a local server and does not use OAuth`,
      })
    }

    return { name: resolved.name, config: resolved.config }
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
