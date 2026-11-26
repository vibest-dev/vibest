import crypto from "node:crypto"

import type { AuthProvider, FetchLike, Implementation } from "@modelcontextprotocol/client"
import type { Mcp } from "@vibest/schema/mcp"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { Cause, Duration, Effect, Exit, FileSystem, Path, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import { McpClient } from "./client.ts"
import { ConnectError, NeedsAuthError, SessionExpiredError } from "./errors.ts"

export * as McpConnection from "./connection.ts"

export type Failure = Extract<Mcp.Status, { readonly status: "failed" | "needs_auth" }>

export type Kind = "tools" | "prompts" | "resources"

export interface Events {
  readonly connecting: Effect.Effect<void>
  readonly connected: Effect.Effect<void>
  readonly failed: (failure: Failure, answered: boolean) => Effect.Effect<void>
  readonly settled: Effect.Effect<void>
  readonly closed: (reason: string) => Effect.Effect<void>
  readonly changed: (kind: Kind) => Effect.Effect<void>
  readonly legacy?: ((version: string | undefined) => Effect.Effect<void>) | undefined
}

export interface Input {
  readonly name: string
  readonly config: Mcp.ServerConfig
  readonly directory: string
  readonly vibestHome?: string | undefined
  readonly npmCacheDir?: string | undefined
  readonly shared?: boolean | undefined
  readonly clientInfo?: Implementation | undefined
  readonly mcpEvents?: boolean | undefined
  readonly eventStreamIdleTimeout?: Duration.Input | undefined
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
  readonly baseFetch?: FetchLike | undefined
  readonly fetch: typeof globalThis.fetch
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly scope: Scope.Scope
  readonly lock: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly callbacks: (effect: Effect.Effect<void>) => void
  readonly fork: (effect: Effect.Effect<void>) => void
  readonly endpointLocks?: KeyedMutex.Interface<string> | undefined
  readonly events: Events
}

export interface Catalog {
  readonly resources: ReadonlyArray<McpClient.Resource>
  readonly templates: ReadonlyArray<McpClient.ResourceTemplate>
}

export interface Connection {
  readonly client: McpClient.Connection | undefined
  readonly tools: ReadonlyArray<McpClient.Tool> | undefined
  readonly toolsMeta: McpClient.ToolListMeta | undefined
  readonly prompts: ReadonlyArray<McpClient.Prompt> | undefined
  readonly start: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
  readonly refreshTools: () => Effect.Effect<void, Error>
  readonly recovering: <A, E extends Error>(
    client: McpClient.Connection,
    run: (client: McpClient.Connection) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>
  readonly catalog: (client: McpClient.Connection) => Effect.Effect<Catalog, Error>
}

interface ConnectionState {
  scope: Scope.Closeable | undefined
  client: McpClient.Connection | undefined
  tools: ReadonlyArray<McpClient.Tool> | undefined
  toolsMeta: McpClient.ToolListMeta | undefined
  prompts: ReadonlyArray<McpClient.Prompt> | undefined
}

export const make = (input: Input): Connection => {
  const state: ConnectionState = {
    scope: undefined,
    client: undefined,
    tools: undefined,
    toolsMeta: undefined,
    prompts: undefined,
  }

  const whenLive =
    (client: McpClient.Connection) =>
    <E>(effect: Effect.Effect<void, E>) =>
      input.callbacks(
        Effect.suspend(() => (state.client === client ? effect : Effect.void)).pipe(input.lock, Effect.ignore),
      )

  const refreshToolsFor = (client: McpClient.Connection) =>
    client.tools().pipe(
      Effect.map((listed) => {
        state.tools = listed.tools
        state.toolsMeta = {
          ...(listed.cacheScope !== undefined && { cacheScope: listed.cacheScope }),
          ...(listed.ttlMs !== undefined && { ttlMs: listed.ttlMs }),
        }
      }),
    )

  const refreshPrompts = (client: McpClient.Connection) =>
    client.prompts().pipe(
      Effect.map((prompts) => {
        state.prompts = prompts
      }),
      Effect.andThen(input.events.changed("prompts")),
    )

  const stop: Effect.Effect<void> = Effect.gen(function* () {
    const scope = state.scope

    if (!scope) return
    state.scope = undefined
    state.client = undefined
    state.tools = undefined
    state.toolsMeta = undefined
    state.prompts = undefined
    yield* Scope.close(scope, Exit.void)
    yield* input.events.changed("tools")
    yield* input.events.changed("resources")
    yield* input.events.changed("prompts")
  })

  const recover = (client: McpClient.Connection) =>
    Effect.gen(function* () {
      if (state.client !== client) return
      yield* Effect.logInfo("mcp session expired, reconnecting", { server: input.name })
      yield* stop
      yield* start
    }).pipe(input.lock)

  const recovering = <A, E extends Error>(
    client: McpClient.Connection,
    run: (client: McpClient.Connection) => Effect.Effect<A, E>,
  ) =>
    run(client).pipe(
      Effect.catchIf(
        (error) => error instanceof SessionExpiredError,
        (error) => recover(client).pipe(Effect.flatMap(() => (state.client ? run(state.client) : Effect.fail(error)))),
      ),
    )

  const watch = (client: McpClient.Connection) => {
    const live = whenLive(client)
    client.onClose((reason) => live(input.events.closed(reason)))
    client.onSessionExpired(() => input.fork(recover(client)))
    client.onToolsChanged(() => live(refreshToolsFor(client).pipe(Effect.andThen(input.events.changed("tools")))))
    client.onPromptsChanged(() => live(refreshPrompts(client)))
    client.onResourcesChanged(() => live(input.events.changed("resources")))
  }

  const start: Effect.Effect<void> = Effect.suspend(() =>
    Effect.gen(function* () {
      yield* input.events.connecting

      if (input.config.type === "remote" && !URL.canParse(input.config.url)) {
        return yield* input.events.failed(
          { status: "failed", error: `Invalid MCP server URL: ${input.config.url}` },
          false,
        )
      }

      const scope = yield* Scope.fork(input.scope)
      state.scope = scope
      const authProvider = yield* input.authProvider
      const config = input.config

      const result = yield* McpClient.connect({
        server: input.name,
        config,
        directory: input.directory,
        vibestHome: input.vibestHome,
        npmCacheDir: input.npmCacheDir,
        authProvider,
        baseFetch: input.baseFetch,
        clientInfo: input.clientInfo,
        roots: !input.shared,
        events: input.mcpEvents,
        eventStreamIdleTimeout: input.eventStreamIdleTimeout,
      }).pipe(
        Effect.flatMap(
          (
            client,
          ): Effect.Effect<
            {
              readonly client: McpClient.Connection
              readonly listed?: McpClient.ToolListResult
            },
            Error
          > =>
            input.shared && !client.modern
              ? Effect.succeed({ client })
              : client.tools().pipe(Effect.map((listed) => ({ client, listed }))),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
        Effect.provideService(FileSystem.FileSystem, input.fs),
        Effect.provideService(Path.Path, input.path),
        Effect.provideService(FetchHttpClient.Fetch, input.fetch),
        Scope.provide(scope),
        (effect) =>
          config.type === "remote" && !input.shared && input.endpointLocks
            ? input.endpointLocks.withLock(config.url)(effect)
            : effect,
        Effect.exit,
      )

      if (Exit.isSuccess(result) && !result.value.listed) {
        yield* Scope.close(scope, Exit.void)
        state.scope = undefined

        return yield* input.events.legacy?.(result.value.client.protocolVersion) ?? Effect.void
      }

      if (Exit.isSuccess(result)) {
        state.client = result.value.client
        state.tools = result.value.listed?.tools
        state.toolsMeta = result.value.listed
          ? {
              ...(result.value.listed.cacheScope !== undefined && { cacheScope: result.value.listed.cacheScope }),
              ...(result.value.listed.ttlMs !== undefined && { ttlMs: result.value.listed.ttlMs }),
            }
          : undefined
        state.prompts = []
        watch(result.value.client)
        yield* input.events.connected
        whenLive(result.value.client)(refreshPrompts(result.value.client))

        return
      }

      yield* Scope.close(scope, Exit.void)
      state.scope = undefined
      const error = Cause.squash(result.cause)

      yield* input.events.failed(
        error instanceof NeedsAuthError
          ? {
              status: "needs_auth",
              error: error.message,
              ...(error.requiredScope !== undefined && { requiredScope: error.requiredScope }),
            }
          : { status: "failed", error: error instanceof Error ? error.message : String(error) },
        error instanceof ConnectError && error.answered === true,
      )
    }).pipe(
      Effect.ensuring(input.events.settled),
      Effect.annotateLogs({ server: input.name, directory: input.directory, connectionID: crypto.randomUUID() }),
    ),
  )

  return {
    get client() {
      return state.client
    },
    get tools() {
      return state.tools
    },
    get toolsMeta() {
      return state.toolsMeta
    },
    get prompts() {
      return state.prompts
    },
    start,
    stop,
    refreshTools: () =>
      Effect.suspend(() => {
        const client = state.client

        if (!client) return Effect.void

        return refreshToolsFor(client)
      }),
    recovering,
    catalog: (client) =>
      recovering(client, (c) =>
        Effect.all(
          {
            resources: c.resources(),
            templates: c.resourceTemplates().pipe(Effect.orElseSucceed(() => [])),
          },
          { concurrency: "unbounded" },
        ),
      ),
  }
}
