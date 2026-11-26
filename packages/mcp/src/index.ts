import { Bus } from "@vibest/core/bus"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Mcp as CoreMcp } from "@vibest/core/mcp"
import { Layout } from "@vibest/schema/layout"
import { Mcp as McpSchema } from "@vibest/schema/mcp"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Clock,
  Effect,
  Fiber,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Semaphore,
  Stream,
  type Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import {
  cachedToolsFor,
  emitStatus,
  loadConfiguredServers,
  createServerEntry,
  readConfigFile,
  serverTools,
  toServerInfo,
  writeGlobalConfig,
  type EntryContext,
  type ServerEntry,
} from "./entry.ts"
import { decodeServerName, parseServerName, verifySkillDigest } from "./helpers.ts"
import { McpMetadataCache } from "./metadata-cache.ts"
import { McpOAuth } from "./oauth.ts"
import { McpPool } from "./pool.ts"
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
  const authManager = yield* McpOAuth.makeAuthManager()
  yield* Scope.addFinalizer(root, authManager.closeAll.pipe(Effect.ignore))
  const servers = yield* Scope.fork(root, "parallel")
  const fork = yield* FiberSet.makeRuntime<never, void, never>()
  const callbacks = yield* FiberSet.makeRuntime<never, void, never>()
  const locks = KeyedMutex.makeUnsafe<string>()
  const reconcileLock = Semaphore.makeUnsafe(1)
  const configPath = path.join(layout.home, "mcp.json")
  const heldEntries = new Map<string, ServerEntry>()
  const lastStatus = new Map<string, McpSchema.Status>()

  const ctx: EntryContext = {
    vibestHome: layout.home,
    configPath,
    fs,
    path,
    bus,
    fetch,
    spawner,
    pool,
    vault,
    metadataCache,
    servers,
    locks,
    callbacks: (effect) => {
      callbacks(effect)
    },
    fork: (effect) => {
      fork(effect)
    },
    heldEntries,
    lastStatus,
    clientInfo: options?.clientInfo,
  }

  const transition = <E>(effect: Effect.Effect<void, E>) =>
    Effect.forkIn(effect, root, { startImmediately: true }).pipe(Effect.flatMap(Fiber.join))

  const resolveConfigured = Effect.fn("Mcp.resolveConfigured")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<
    { readonly name: McpSchema.ServerName; readonly config: McpSchema.ServerConfig; readonly directory: string },
    McpSchema.NotFoundError
  > {
    const dir = directory ?? layout.home
    const configured = yield* loadConfiguredServers(ctx, directory)
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

  const acquireActiveEntry = (
    rawServer: string,
    directory: string | undefined,
  ): Effect.Effect<ServerEntry, McpSchema.NotFoundError, Scope.Scope> =>
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

        return held
      }

      return yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const ephemeral = createServerEntry(ctx, resolved.name, resolved.config, resolved.directory)

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
      )
    })

  const withActiveEntry = <A, E>(
    rawServer: string,
    directory: string | undefined,
    run: (entry: ServerEntry) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | McpSchema.NotFoundError> =>
    Effect.scoped(acquireActiveEntry(rawServer, directory).pipe(Effect.flatMap(run)))

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
    const configured = yield* loadConfiguredServers(ctx, directory)
    const infos: Array<McpSchema.ServerInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || Option.isNone(decoded)) continue
      infos.push(yield* toServerInfo(ctx, decoded.value, config, dir, heldEntries.get(rawName)))
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
        const existing = yield* readConfigFile(fs, configPath)
        yield* writeGlobalConfig(ctx, { ...existing, [name]: config })
        yield* metadataCache.invalidate(name)

        yield* transition(
          Effect.gen(function* () {
            const oldHeld = heldEntries.get(name)

            if (oldHeld) {
              yield* oldHeld.connection.stop
              heldEntries.delete(name)
            }

            lastStatus.set(name, config.disabled ? { status: "disabled" } : { status: "idle" })
          }).pipe(locks.withLock(name)),
        )
      }),
    )

    return yield* toServerInfo(ctx, name, config, layout.home)
  })

  const remove = Effect.fn("Mcp.remove")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, McpSchema.NotFoundError> {
    yield* reconcileLock.withPermit(
      Effect.gen(function* () {
        const existing = yield* readConfigFile(fs, configPath)

        if (!(rawServer in existing)) {
          return yield* new McpSchema.NotFoundError({
            server: rawServer,
            message: `MCP server not found: ${rawServer}`,
          })
        }

        const next = { ...existing }
        delete next[rawServer]
        yield* writeGlobalConfig(ctx, next).pipe(Effect.ignore)
        yield* metadataCache.invalidate(rawServer)

        yield* transition(
          Effect.gen(function* () {
            lastStatus.delete(rawServer)
            const held = heldEntries.get(rawServer)

            if (held) {
              yield* held.connection.stop
              heldEntries.delete(rawServer)
            }
          }).pipe(locks.withLock(rawServer)),
        )
      }),
    )
  })

  const connect = Effect.fn("Mcp.connect")(function* (
    rawServer: string,
    directory?: string,
  ): Effect.fn.Return<McpSchema.ServerInfo, McpSchema.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer, directory)

    yield* transition(
      Effect.gen(function* () {
        let entry = heldEntries.get(rawServer)

        if (
          !entry ||
          JSON.stringify(entry.config) !== JSON.stringify(resolved.config) ||
          entry.directory !== resolved.directory
        ) {
          if (entry) yield* entry.connection.stop
          entry = createServerEntry(ctx, resolved.name, resolved.config, resolved.directory)
          heldEntries.set(rawServer, entry)
        } else if (!entry.config.disabled && !entry.connection.client) {
          yield* entry.connection.stop
        }

        if (!entry.config.disabled && !entry.connection.client) {
          yield* entry.connection.start
        }
      }).pipe(locks.withLock(rawServer)),
    )

    const current = heldEntries.get(rawServer)

    return yield* toServerInfo(ctx, resolved.name, resolved.config, resolved.directory, current)
  })

  const disconnect = Effect.fn("Mcp.disconnect")(function* (
    rawServer: string,
  ): Effect.fn.Return<void, McpSchema.NotFoundError> {
    const resolved = yield* resolveConfigured(rawServer)

    yield* transition(
      Effect.gen(function* () {
        const held = heldEntries.get(rawServer)

        if (held) {
          yield* held.connection.stop
          heldEntries.delete(rawServer)
        }

        const nextStatus: McpSchema.Status = resolved.config.disabled ? { status: "disabled" } : { status: "idle" }
        yield* emitStatus(ctx, resolved.name, nextStatus)
      }).pipe(locks.withLock(rawServer)),
    )
  })

  const tools = Effect.fn("Mcp.tools")(function* (
    rawServer?: string,
    directory?: string,
  ): Effect.fn.Return<ReadonlyArray<McpSchema.ToolInfo>, McpSchema.NotFoundError> {
    if (rawServer !== undefined) {
      const resolved = yield* resolveConfigured(rawServer, directory)
      const cached = yield* cachedToolsFor(ctx, resolved.name, resolved.config, resolved.directory)

      if (cached.length > 0 || resolved.config.disabled) return cached

      return yield* withActiveEntry(rawServer, directory, (entry) => Effect.succeed(serverTools(entry)))
    }

    const dir = directory ?? layout.home
    const configured = yield* loadConfiguredServers(ctx, directory)
    const all: Array<McpSchema.ToolInfo> = []

    for (const rawName of Object.keys(configured).toSorted()) {
      const config = configured[rawName]
      const decoded = decodeServerName(rawName)

      if (!config || config.disabled || Option.isNone(decoded)) continue
      const items = yield* cachedToolsFor(ctx, decoded.value, config, dir)
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

        return yield* entry.connection
          .recovering(client, (liveClient) => liveClient.callTool({ name: input.tool, args: input.args }))
          .pipe(
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

  const eventStream = (input: {
    readonly server: string
    readonly name: string
    readonly arguments?: Schema.JsonObject | undefined
    readonly cursor?: string | null | undefined
    readonly maxAgeMs?: number | undefined
    readonly directory?: string | undefined
  }): Stream.Stream<McpSchema.EventMessage, McpSchema.NotFoundError | McpSchema.ToolCallError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = yield* acquireActiveEntry(input.server, input.directory)

        if (entry.config.disabled) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "events/stream",
            message: `MCP server "${input.server}" is disabled`,
          })
        }

        const client = entry.connection.client

        if (!client) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "events/stream",
            message: `MCP server "${input.server}" is not connected`,
          })
        }

        if (!client.events) {
          return yield* new McpSchema.ToolCallError({
            server: input.server,
            tool: "events/stream",
            message: `MCP server "${input.server}" does not advertise io.modelcontextprotocol/events`,
          })
        }

        yield* entry.connection.pinStream()

        return client.events
          .stream({
            name: input.name,
            ...(input.arguments !== undefined && { arguments: input.arguments }),
            ...(input.cursor !== undefined && { cursor: input.cursor }),
            ...(input.maxAgeMs !== undefined && { maxAgeMs: input.maxAgeMs }),
          })
          .pipe(
            Stream.mapError(
              (error) =>
                new McpSchema.ToolCallError({
                  server: input.server,
                  tool: "events/stream",
                  message: error.message,
                }),
            ),
          )
      }),
    )

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
    awaitStartup,
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
    eventStream,
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
