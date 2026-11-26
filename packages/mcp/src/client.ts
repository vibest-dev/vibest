import url from "node:url"

import {
  Client,
  InsufficientScopeError,
  isJSONRPCRequest,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type CallToolResult as SdkCallToolResult,
  type FetchLike,
  type GetPromptResult,
  type Implementation,
  type JSONRPCMessage,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplateType,
  type Transport,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client"
import { Mcp } from "@vibest/schema/mcp"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Option,
  PlatformError,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect"

import {
  ConnectError,
  EventStreamRejectedError,
  EventStreamTerminatedError,
  NeedsAuthError,
  SessionExpiredError,
} from "./errors.ts"
import { McpOAuth } from "./oauth.ts"
import { McpSecrets } from "./secrets.ts"
import { McpStdio } from "./stdio.ts"

export * as McpClient from "./client.ts"

export { ConnectError, EventStreamRejectedError, EventStreamTerminatedError, NeedsAuthError, SessionExpiredError }

const DEFAULT_STARTUP_TIMEOUT = 30_000
const DEFAULT_CATALOG_TIMEOUT = 30_000
const DEFAULT_EXECUTION_TIMEOUT = 10 * 60 * 1_000
const TERMINATE_TIMEOUT = 1_000
const HEADER_MISMATCH = -32020
const EVENTS_EXTENSION = "io.modelcontextprotocol/events"
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills"
const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
const EVENT_STREAM_IDLE = Duration.seconds(60)
const EVENT_LIST_PAGES = 100
const SKILL_LIST_PAGES = 20
const EVENT_STREAM_REJECTED = new Set([-32601, -32602, -32023, -32024, -32026])

const CursorSchema = Schema.optional(Schema.NullOr(Schema.String))

const SubscribedFields = {
  _meta: Schema.Struct({ [SUBSCRIPTION_ID_KEY]: Schema.Union([Schema.String, Schema.Number]) }),
}

const EventListStandard = Schema.toStandardSchemaV1(
  Schema.Struct({
    events: Schema.Array(Mcp.EventType),
    nextCursor: Schema.optional(Schema.String),
  }),
)

const SkillListStandard = Schema.toStandardSchemaV1(
  Schema.Struct({
    skills: Schema.Array(Mcp.SkillEntry),
    nextCursor: Schema.optional(Schema.String),
    resultType: Schema.optional(Schema.String),
  }),
)

const StreamResultStandard = Schema.toStandardSchemaV1(Schema.Json)

const ActiveNotificationStandard = Schema.toStandardSchemaV1(
  Schema.Struct({ cursor: CursorSchema, truncated: Schema.optional(Schema.Boolean), ...SubscribedFields }),
)

const EventNotificationStandard = Schema.toStandardSchemaV1(
  Schema.Struct({
    eventId: Schema.String,
    name: Schema.String,
    timestamp: Schema.String,
    data: Schema.Json,
    cursor: CursorSchema,
    ...SubscribedFields,
  }),
)

const HeartbeatNotificationStandard = Schema.toStandardSchemaV1(
  Schema.Struct({ cursor: CursorSchema, ...SubscribedFields }),
)

const ErrorNotificationStandard = Schema.toStandardSchemaV1(
  Schema.Struct({ error: Mcp.EventError, ...SubscribedFields }),
)

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json)
const decodeJsonObject = Schema.decodeUnknownOption(JsonObjectSchema)
const decodeJson = Schema.decodeUnknownOption(Schema.Json)

export type { GetPromptResult, Prompt, ReadResourceResult, Resource }

export type ResourceTemplate = ResourceTemplateType

export interface Tool {
  readonly name: string
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly inputSchema: Schema.JsonObject
  readonly outputSchema?: Schema.JsonObject | undefined
  readonly annotations?: Schema.JsonObject | undefined
}

export interface ToolListMeta {
  readonly cacheScope?: "public" | "private" | undefined
  readonly ttlMs?: number | undefined
}

export interface ToolListResult extends ToolListMeta {
  readonly tools: ReadonlyArray<Tool>
}

export interface Events {
  readonly list: () => Effect.Effect<ReadonlyArray<Mcp.EventType>, Error>
  readonly stream: (input: {
    readonly name: string
    readonly arguments?: Schema.JsonObject | undefined
    readonly cursor?: string | null | undefined
    readonly maxAgeMs?: number | undefined
  }) => Stream.Stream<Mcp.EventMessage, Error>
}

export interface Skills {
  readonly list: () => Effect.Effect<ReadonlyArray<Mcp.SkillEntry>, Error>
}

export interface Connection {
  readonly modern: boolean
  readonly protocolVersion: string | undefined
  readonly title: string | undefined
  readonly instructions: string | undefined
  readonly capabilities: Mcp.ServerCapabilities
  readonly tools: () => Effect.Effect<ToolListResult, Error>
  readonly prompts: () => Effect.Effect<ReadonlyArray<Prompt>, Error>
  readonly resources: () => Effect.Effect<ReadonlyArray<Resource>, Error>
  readonly resourceTemplates: () => Effect.Effect<ReadonlyArray<ResourceTemplateType>, Error>
  readonly readResource: (input: { readonly uri: string }) => Effect.Effect<ReadResourceResult | undefined, Error>
  readonly prompt: (input: {
    readonly name: string
    readonly args?: Readonly<Record<string, string>> | undefined
  }) => Effect.Effect<GetPromptResult, Error>
  readonly callTool: (input: {
    readonly name: string
    readonly args?: Schema.JsonObject | undefined
  }) => Effect.Effect<Mcp.CallResult, Error>
  readonly events: Events | undefined
  readonly skills: Skills | undefined
  readonly onClose: (callback: (reason: string) => void) => void
  readonly onSessionExpired: (callback: () => void) => void
  readonly onToolsChanged: (callback: () => void) => void
  readonly onPromptsChanged: (callback: () => void) => void
  readonly onResourcesChanged: (callback: () => void) => void
}

export interface Attached {
  readonly type: "attached"
  readonly transport: Transport
}

export interface ConnectOptions {
  readonly server: string
  readonly config: Mcp.ServerConfig | Attached
  readonly directory: string
  readonly vibestHome?: string | undefined
  readonly npmCacheDir?: string | undefined
  readonly authProvider?: AuthProvider | undefined
  readonly baseFetch?: FetchLike | undefined
  readonly clientInfo?: Implementation | undefined
  readonly roots?: boolean | undefined
  readonly events?: boolean | undefined
  readonly eventStreamIdleTimeout?: Duration.Input | undefined
}

interface ClientErrorState {
  lastError: string | undefined
  requiredScope: string | undefined
}

interface SessionState {
  transport: StreamableHTTPClientTransport | undefined
  expired: (() => void) | undefined
  reported: boolean
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect.tryPromise catch boundary
const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

const describe = (error: Error | string | number | boolean | null | undefined): string => {
  if (!(error instanceof Error)) return String(error)

  const detail =
    error instanceof SdkHttpError
      ? `HTTP ${error.status}`
      : !(error instanceof SdkError) && "code" in error && Predicate.isString(error.code)
        ? error.code
        : undefined

  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message
}

const isTransient = (error: Error | string | number | boolean | null | undefined): boolean =>
  error instanceof SdkHttpError
    ? error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    : error instanceof TypeError && "code" in error

const repeats = (error: Error | string | number | boolean | null | undefined): boolean => {
  if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && error.cause instanceof Error) {
    return repeats(error.cause)
  }

  return (
    (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) ||
    (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) ||
    (error instanceof OAuthError && error.code === OAuthErrorCode.TemporarilyUnavailable) ||
    isTransient(error) ||
    PlatformError.isPlatformError(error)
  )
}

const rejectsUnknownQuery = (target: URL): boolean =>
  target.hostname.endsWith(".googleapis.com") || target.hostname === "googleapis.com"

const negotiation = (protocol: Mcp.Protocol | undefined): VersionNegotiationOptions => {
  if (protocol === "legacy") return { mode: "legacy" }

  if (protocol === "2026-07-28") return { mode: { pin: "2026-07-28" } }

  return { mode: "auto" }
}

const toCallToolResult = (result: SdkCallToolResult): Mcp.CallResult => {
  const content: Array<Mcp.CallContent> = []

  if ("content" in result && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text })
      } else if (block.type === "image" || block.type === "audio") {
        content.push({ type: "media", data: block.data, mimeType: block.mimeType })
      } else if (block.type === "resource") {
        if ("text" in block.resource) {
          content.push({ type: "text", text: block.resource.text })
        } else if ("blob" in block.resource) {
          content.push({
            type: "media",
            data: block.resource.blob,
            mimeType: block.resource.mimeType ?? "application/octet-stream",
            uri: block.resource.uri,
          })
        }
      }
    }
  }

  const structured =
    "structuredContent" in result && result.structuredContent !== undefined
      ? Option.getOrUndefined(decodeJson(result.structuredContent))
      : undefined

  return {
    isError: "isError" in result && result.isError === true,
    ...(structured !== undefined && { structured }),
    content,
  }
}

export const connect = Effect.fn("McpClient.connect")(function* (options: ConnectOptions) {
  const server = options.server

  const resolvedConfig: Mcp.ServerConfig | Attached =
    options.config.type === "attached"
      ? options.config
      : yield* McpSecrets.resolveServerConfig(server, options.config).pipe(
          Effect.mapError((error) => new ConnectError({ server, message: error.message })),
        )

  const timeout = resolvedConfig.type === "attached" ? undefined : resolvedConfig.timeout
  const protocol = resolvedConfig.type === "attached" ? "legacy" : resolvedConfig.protocol
  const changed = { tools: () => {}, prompts: () => {}, resources: () => {} }

  const listChanged = (key: keyof typeof changed) => ({
    autoRefresh: false,
    debounceMs: 0,
    onChanged: () => changed[key](),
  })

  const streams = new Map<string, Queue.Queue<Mcp.EventMessage, Error | Cause.Done>>()
  const pendingEventQueues: Array<Queue.Queue<Mcp.EventMessage, Error | Cause.Done>> = []
  const errorState: ClientErrorState = { lastError: undefined, requiredScope: undefined }

  const explain = (error: Error): string =>
    error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed && errorState.lastError
      ? `${describe(error)}: ${errorState.lastError}`
      : describe(error)

  const retrying = <A>(what: string, effect: Effect.Effect<A, Error>, deadline = Infinity) =>
    Effect.retry(
      effect,
      Schedule.max([Schedule.exponential("250 millis", 4), Schedule.recurs(2)]).pipe(
        Schedule.setInputType<Error>(),
        Schedule.while(({ input, now, duration }) =>
          !isTransient(input) || now + Duration.toMillis(duration) >= deadline
            ? Effect.succeed(false)
            : Effect.logWarning(`retrying ${what}`, { server, error: describe(input) }).pipe(Effect.as(true)),
        ),
      ),
    )

  const interceptEventStreams = (transport: Transport): void => {
    const originalSend = transport.send.bind(transport)

    transport.send = (message: JSONRPCMessage, sendOptions) => {
      if (isJSONRPCRequest(message) && message.method === "events/stream") {
        const nextQueue = pendingEventQueues.shift()

        if (nextQueue) {
          streams.set(String(message.id), nextQueue)
        }
      }

      return originalSend(message, sendOptions)
    }
  }

  const initialize = Effect.fn("McpClient.initialize")(function* (transport: Transport) {
    if (options.events) interceptEventStreams(transport)

    const client = new Client(options.clientInfo ?? { name: "vibest", version: "0.0.2" }, {
      capabilities: {
        ...(options.roots !== false && { roots: {} }),
        extensions: {
          ...(options.events === true && { [EVENTS_EXTENSION]: {} }),
          [SKILLS_EXTENSION]: {},
        },
      },
      versionNegotiation: negotiation(protocol),
      listChanged: {
        tools: listChanged("tools"),
        prompts: listChanged("prompts"),
        resources: listChanged("resources"),
      },
    })

    client.onerror = (error) => {
      if (error.name === "AbortError") return
      errorState.lastError = describe(error)
    }

    if (options.roots !== false) {
      client.setRequestHandler("roots/list", () => ({
        roots: [{ uri: url.pathToFileURL(options.directory).href }],
      }))
    }

    if (options.events) {
      const subscribed = (params: { readonly _meta: { readonly [SUBSCRIPTION_ID_KEY]: string | number } }) =>
        streams.get(String(params._meta[SUBSCRIPTION_ID_KEY]))

      client.setNotificationHandler("notifications/events/active", { params: ActiveNotificationStandard }, (params) => {
        const queue = subscribed(params)

        if (queue) {
          Queue.offerUnsafe(queue, {
            type: "active",
            cursor: params.cursor ?? null,
            truncated: params.truncated === true,
          })
        }
      })

      client.setNotificationHandler("notifications/events/event", { params: EventNotificationStandard }, (params) => {
        const queue = subscribed(params)

        if (queue) {
          Queue.offerUnsafe(queue, {
            type: "event",
            eventId: params.eventId,
            name: params.name,
            timestamp: params.timestamp,
            data: params.data,
            cursor: params.cursor ?? null,
          })
        }
      })

      client.setNotificationHandler(
        "notifications/events/heartbeat",
        { params: HeartbeatNotificationStandard },
        (params) => {
          const queue = subscribed(params)

          if (queue) Queue.offerUnsafe(queue, { type: "heartbeat", cursor: params.cursor ?? null })
        },
      )

      client.setNotificationHandler("notifications/events/error", { params: ErrorNotificationStandard }, (params) => {
        const queue = subscribed(params)

        if (queue) Queue.offerUnsafe(queue, { type: "error", error: params.error })
      })

      client.setNotificationHandler(
        "notifications/events/terminated",
        { params: ErrorNotificationStandard },
        (params) => {
          const queue = subscribed(params)

          if (queue) {
            Queue.failCauseUnsafe(queue, Cause.fail(new EventStreamTerminatedError({ server, ...params.error })))
          }
        },
      )
    }

    yield* Effect.tryPromise({
      try: (signal) => client.connect(transport, { timeout: timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT, signal }),
      catch: toError,
    }).pipe(Effect.onError(() => Effect.promise(() => transport.close()).pipe(Effect.ignore)))

    return client
  })

  const session: SessionState = {
    transport: undefined,
    expired: undefined,
    reported: false,
  }

  const failure = (error: Error): Error => {
    if (error instanceof SessionExpiredError) return error

    if (!(error instanceof SdkHttpError) || session.transport?.sessionId === undefined) return new Error(explain(error))

    const expired =
      error.status === 404 ||
      (error.status === 400 &&
        Predicate.isString(error.data.text) &&
        error.data.text.includes("Bad Request: Server not initialized"))

    if (!expired) return new Error(explain(error))

    if (!session.reported) {
      session.reported = true
      session.expired?.()
    }

    return new SessionExpiredError({ server })
  }

  const exit = yield* Effect.gen(function* () {
    if (resolvedConfig.type === "attached") return yield* initialize(resolvedConfig.transport)

    if (resolvedConfig.type === "local") {
      const [command, ...args] = resolvedConfig.command

      const transport = yield* McpStdio.make({
        server,
        command,
        args,
        cwd: McpStdio.resolveCwd(options.directory, resolvedConfig.cwd),
        environment: resolvedConfig.environment ?? {},
        vibestHome: options.vibestHome,
        npmCacheDir: options.npmCacheDir,
      })

      return yield* initialize(transport)
    }

    const scopedFetch = yield* McpOAuth.loggedFetch({
      server,
      serverUrl: resolvedConfig.url,
      directory: options.directory,
      customHeaders: resolvedConfig.headers,
      baseFetch: options.baseFetch,
    })

    const inspectedFetch: FetchLike = async (input, init) => {
      const response = await scopedFetch(input, init)
      const neededScope = McpOAuth.extractInsufficientScope(response)

      if (neededScope !== undefined) {
        errorState.requiredScope = neededScope
      }

      return response
    }

    const parsedUrl = new URL(resolvedConfig.url)

    const addedCodemode =
      resolvedConfig.codemode !== false && !parsedUrl.searchParams.has("codemode") && !rejectsUnknownQuery(parsedUrl)

    if (addedCodemode) parsedUrl.searchParams.set("codemode", "false")

    const open = (targetUrl: URL) =>
      Effect.suspend(() => {
        const transport = new StreamableHTTPClientTransport(targetUrl, {
          ...(options.authProvider !== undefined && { authProvider: options.authProvider }),
          fetch: inspectedFetch,
        })

        session.transport = transport

        return initialize(transport)
      })

    const deadline = (yield* Clock.currentTimeMillis) + (timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT)

    return yield* retrying(
      "MCP connect",
      open(parsedUrl).pipe(
        Effect.catch((error) => {
          if (!addedCodemode || !(error instanceof SdkHttpError) || (error.status !== 400 && error.status !== 404)) {
            return Effect.fail(error)
          }

          return open(new URL(resolvedConfig.url))
        }),
      ),
      deadline,
    )
  }).pipe(Effect.exit)

  if (Exit.isSuccess(exit)) {
    const client = exit.value

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const transport = session.transport
        client.onerror = () => {}

        if (transport?.sessionId !== undefined && !session.reported) {
          yield* Effect.tryPromise({
            try: () => transport.terminateSession(),
            catch: toError,
          }).pipe(
            Effect.timeoutOrElse({
              duration: TERMINATE_TIMEOUT,
              orElse: () => Effect.fail(new Error(`Timed out after ${TERMINATE_TIMEOUT}ms`)),
            }),
            Effect.ignore,
          )
        }

        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      }),
    )

    const catalog = { timeout: timeout?.catalog ?? DEFAULT_CATALOG_TIMEOUT }
    const execution = timeout?.execution ?? DEFAULT_EXECUTION_TIMEOUT
    const idleTimeout = options.eventStreamIdleTimeout ?? EVENT_STREAM_IDLE

    const request = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => failure(toError(error)),
      }).pipe(Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })))

    const list = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      retrying(
        what,
        Effect.tryPromise({
          try: run,
          catch: toError,
        }),
      ).pipe(
        Effect.mapError(failure),
        Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })),
      )

    const advertised = (capability: "tools" | "prompts" | "resources") =>
      Boolean(client.getServerCapabilities()?.[capability])

    const serverCapabilities = client.getServerCapabilities()
    const hasEvents = Boolean(options.events && serverCapabilities?.extensions?.[EVENTS_EXTENSION])
    const hasSkills = Boolean(serverCapabilities?.extensions?.[SKILLS_EXTENSION])

    const capabilities: Mcp.ServerCapabilities = {
      tools: advertised("tools"),
      resources: advertised("resources") || hasSkills,
      events: hasEvents,
      skills: hasSkills,
    }

    const connection: Connection = {
      modern: client.getProtocolEra() === "modern",
      protocolVersion: client.getNegotiatedProtocolVersion(),
      title: client.getServerVersion()?.title?.trim() || undefined,
      instructions: client.getInstructions()?.trim() || undefined,
      capabilities,
      skills: hasSkills
        ? {
            list: Effect.fn("McpClient.skills.list")(function* () {
              const items: Array<Mcp.SkillEntry> = []
              let cursor: string | undefined

              for (let page = 0; page < SKILL_LIST_PAGES; page++) {
                const result = yield* list("list MCP skills", (signal) =>
                  client.request(
                    { method: "skills/list", params: cursor === undefined ? {} : { cursor } },
                    SkillListStandard,
                    { ...catalog, signal },
                  ),
                )

                items.push(...result.skills)
                cursor = result.nextCursor

                if (cursor === undefined || result.resultType === "complete") return items
              }

              return items
            }),
          }
        : undefined,
      events: hasEvents
        ? {
            list: Effect.fn("McpClient.events.list")(function* () {
              const events: Array<Mcp.EventType> = []
              let cursor: string | undefined

              for (let page = 0; page < EVENT_LIST_PAGES; page++) {
                const result = yield* list("list MCP events", (signal) =>
                  client.request(
                    { method: "events/list", params: cursor === undefined ? {} : { cursor } },
                    EventListStandard,
                    { ...catalog, signal },
                  ),
                )

                events.push(...result.events)
                cursor = result.nextCursor

                if (cursor === undefined) return events
              }

              return events
            }),
            stream: (input) =>
              Stream.callback<Mcp.EventMessage, Error>((queue) =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      const pendingIdx = pendingEventQueues.indexOf(queue)

                      if (pendingIdx >= 0) pendingEventQueues.splice(pendingIdx, 1)

                      for (const [id, openQueue] of streams) {
                        if (openQueue === queue) streams.delete(id)
                      }
                    }),
                  )

                  yield* Effect.sync(() => {
                    pendingEventQueues.push(queue)
                  })

                  yield* Effect.tryPromise({
                    try: (signal) =>
                      client.request({ method: "events/stream", params: input }, StreamResultStandard, {
                        signal,
                        timeout: 2_147_483_647,
                      }),
                    catch: (error) =>
                      error instanceof ProtocolError && EVENT_STREAM_REJECTED.has(error.code)
                        ? new EventStreamRejectedError({ server, code: error.code, message: error.message })
                        : failure(toError(error)),
                  }).pipe(
                    Effect.matchEffect({
                      onFailure: (error) => Queue.fail(queue, error),
                      onSuccess: () => Queue.end(queue),
                    }),
                    Effect.forkScoped,
                  )
                }),
              ).pipe(
                Stream.timeoutOrElse({
                  duration: idleTimeout,
                  orElse: () => Stream.fail(new Error(`MCP server ${server} sent nothing on the event stream`)),
                }),
              ),
          }
        : undefined,
      tools: () =>
        advertised("tools")
          ? list("list MCP tools", (signal) =>
              client.listTools(undefined, { ...catalog, cacheMode: "bypass", signal }),
            ).pipe(
              Effect.map((result): ToolListResult => {
                const tools: Array<Tool> = []

                for (const rawTool of result.tools) {
                  if (!rawTool.name) continue
                  const inputSchemaOpt = decodeJsonObject(rawTool.inputSchema)

                  const inputSchema: Schema.JsonObject = Option.isSome(inputSchemaOpt)
                    ? { type: "object", ...inputSchemaOpt.value }
                    : { type: "object" }

                  const outputSchema =
                    rawTool.outputSchema !== undefined
                      ? Option.getOrUndefined(decodeJsonObject(rawTool.outputSchema))
                      : undefined

                  const annotations =
                    rawTool.annotations !== undefined
                      ? Option.getOrUndefined(decodeJsonObject(rawTool.annotations))
                      : undefined

                  tools.push({
                    name: rawTool.name,
                    ...(rawTool.title !== undefined && { title: rawTool.title }),
                    ...(rawTool.description !== undefined && { description: rawTool.description }),
                    inputSchema,
                    ...(outputSchema !== undefined && { outputSchema }),
                    ...(annotations !== undefined && { annotations }),
                  })
                }

                const rawCacheScope = Predicate.hasProperty(result, "cacheScope") ? result.cacheScope : undefined
                const cacheScope = rawCacheScope === "public" || rawCacheScope === "private" ? rawCacheScope : undefined
                const rawTtlMs = Predicate.hasProperty(result, "ttlMs") ? result.ttlMs : undefined
                const ttlMs = Predicate.isNumber(rawTtlMs) ? rawTtlMs : undefined

                return {
                  tools,
                  ...(cacheScope !== undefined && { cacheScope }),
                  ...(ttlMs !== undefined && { ttlMs }),
                }
              }),
            )
          : Effect.succeed({ tools: [] }),
      prompts: () =>
        advertised("prompts")
          ? list("list MCP prompts", (signal) => client.listPrompts(undefined, { ...catalog, signal })).pipe(
              Effect.map((r) => r.prompts),
            )
          : Effect.succeed([]),
      resources: () =>
        advertised("resources")
          ? list("list MCP resources", (signal) => client.listResources(undefined, { ...catalog, signal })).pipe(
              Effect.map((r) => r.resources),
            )
          : Effect.succeed([]),
      resourceTemplates: () =>
        advertised("resources")
          ? list("list MCP resource templates", (signal) =>
              client.listResourceTemplates(undefined, { ...catalog, signal }),
            ).pipe(Effect.map((r) => r.resourceTemplates))
          : Effect.succeed([]),
      readResource: (input) => {
        if (!advertised("resources") && !hasSkills) return Effect.succeed(undefined)

        return request("read MCP resource", (signal) =>
          client.readResource({ uri: input.uri }, { signal, timeout: execution }),
        )
      },
      prompt: (input) =>
        request("get MCP prompt", (signal) =>
          client.getPrompt(
            { name: input.name, arguments: input.args ? { ...input.args } : {} },
            { signal, timeout: execution },
          ),
        ),
      callTool: (input) => {
        const call = Effect.tryPromise({
          try: (signal) =>
            client.callTool(
              { name: input.name, arguments: input.args ? { ...input.args } : {} },
              {
                signal,
                timeout: execution,
                onprogress: () => {},
              },
            ),
          catch: toError,
        })

        return call.pipe(
          Effect.catchIf(
            (error) => connection.modern && error instanceof ProtocolError && error.code === HEADER_MISMATCH,
            () => connection.tools().pipe(Effect.andThen(call)),
          ),
          Effect.mapError(failure),
          Effect.map(toCallToolResult),
        )
      },
      onClose: (callback) => {
        client.onclose = () =>
          callback(errorState.lastError ? `Connection closed: ${errorState.lastError}` : "Connection closed")
      },
      onSessionExpired: (callback) => {
        session.expired = callback
      },
      onToolsChanged: (callback) => {
        changed.tools = callback
      },
      onPromptsChanged: (callback) => {
        changed.prompts = callback
      },
      onResourcesChanged: (callback) => {
        changed.resources = callback
      },
    }

    return connection
  }

  const rawError = Cause.squash(exit.cause)
  const error = rawError instanceof Error ? rawError : toError(String(rawError))

  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError) {
    return yield* new NeedsAuthError({
      server,
      message: error.message,
      ...(errorState.requiredScope !== undefined && { requiredScope: errorState.requiredScope }),
    })
  }

  if (error instanceof SdkHttpError && error.status === 403 && errorState.requiredScope !== undefined) {
    return yield* new NeedsAuthError({
      server,
      message: `Insufficient scope: ${errorState.requiredScope || "re-authentication required"}`,
      requiredScope: errorState.requiredScope,
    })
  }

  if (error instanceof UnsupportedProtocolVersionError) {
    return yield* new ConnectError({
      server,
      message: `${error.message}; supported: ${error.supported.join(", ")}`,
    })
  }

  return yield* new ConnectError({ server, message: explain(error), answered: !repeats(error) })
})
