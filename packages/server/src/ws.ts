import { Agents } from "@vibest/core/agents"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Harness } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harnesses"
import { Identity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { PluginLoader, pluginLoaderNode, Plugins } from "@vibest/core/plugin"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { RepositoryUrl } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { EntrySession } from "@vibest/core/session/entry"
import { Starts } from "@vibest/core/session/starts"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { UI_WS_CALLS } from "@vibest/protocol/access"
import { TOKEN_HEADER } from "@vibest/protocol/protocol"
import { Caller, CallerGate, type CallerIdentity, Forbidden, VibestRpcs } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { Config, Context, Data, Effect, FileSystem, Layer, Option, Predicate, Queue, Schema, Scope } from "effect"
import { Hex } from "effect/encoding"
import * as Headers from "effect/http/Headers"
import * as HttpServer from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as NetAddress from "effect/net/NetAddress"
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

import { AdmissionLive, ProtocolGateLive } from "./gates.ts"
import { DaemonHandlers } from "./handlers/daemon.ts"
import * as Listing from "./listing.ts"
import { Load } from "./machine/load.ts"
import { Machines } from "./machine/machines.ts"
import { Peer } from "./machine/peer.ts"
import { Remote } from "./machine/remote.ts"
import { handlersCore } from "./server.ts"
import { services } from "./services.ts"
import { UpdateCheck } from "./update-check.ts"
import { WatchFeed } from "./watch-feed.ts"

export const WsInfo = Schema.Struct({
  url: Schema.String,
  port: Schema.Number,
  token: Schema.String,
  protocol: Schema.Number,
  version: Schema.String,
  pid: Schema.Number,
})

export type WsInfo = typeof WsInfo.Type

const WsInfoJson = Schema.fromJsonString(WsInfo)

const WsConfigFile = Schema.Struct({
  websocket: Schema.optional(Schema.Boolean),
})

const RequestIdSchema = Schema.Union([Schema.String, Schema.Number])

const ClientMessageSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Request"),
    id: RequestIdSchema,
    tag: Schema.String,
    payload: Schema.Unknown,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    isNotification: Schema.optional(Schema.Literal(true)),
    traceId: Schema.optional(Schema.String),
    spanId: Schema.optional(Schema.String),
    sampled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.tag("Ack"), requestId: RequestIdSchema }),
  Schema.Struct({ _tag: Schema.tag("Interrupt"), requestId: RequestIdSchema }),
  Schema.Struct({ _tag: Schema.tag("Ping") }),
  Schema.Struct({ _tag: Schema.tag("Eof") }),
])

const decodeWsConfig = Schema.decodeUnknownOption(WsConfigFile)
const decodeRpcMessage = Schema.decodeUnknownOption(ClientMessageSchema)
const Callers = Data.taggedEnum<CallerIdentity>()
const ClientMessages = Data.taggedEnum<RpcMessage.FromClientEncoded>()

export const readWsInfo = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WsInfoJson)),
    Effect.option,
  )

declare const crypto: { readonly getRandomValues: (bytes: Uint8Array) => Uint8Array }
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const randomHex = (byteLength: number): string => Hex.encode(crypto.getRandomValues(new Uint8Array(byteLength)))

const tokenMatches = (expected: Uint8Array, candidate: string | undefined): boolean => {
  if (candidate === undefined) return false
  const actual = textEncoder.encode(candidate)

  if (actual.length !== expected.length) return false
  let diff = 0

  for (let i = 0; i < expected.length; i++) {
    diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0)
  }

  return diff === 0
}

const wsEnabled = Effect.gen(function* () {
  const env = yield* Config.option(Config.String("VIBEST_WEBSOCKET")).pipe(Effect.orElseSucceed(() => Option.none()))

  if (Option.isSome(env)) {
    const normalized = env.value.trim().toLowerCase()

    if (normalized === "0" || normalized === "false") return false
  }

  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const loader = yield* PluginLoader

  const text = yield* fs.readFileString(layout.config).pipe(Effect.option)

  if (Option.isNone(text)) return true

  const parsed = yield* Effect.try(() => loader.parseJsonc(text.value)).pipe(Effect.option)

  if (Option.isNone(parsed)) return true

  const decoded = decodeWsConfig(parsed.value)

  if (Option.isSome(decoded) && decoded.value.websocket === false) return false

  return true
})

const writePrivateFile = (file: string, content: string, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmp = `${file}.${pid}.${randomHex(4)}.tmp`

    yield* Effect.scoped(
      fs.open(tmp, { flag: "w", mode: 0o600 }).pipe(
        Effect.flatMap((handle) => handle.writeAll(new TextEncoder().encode(content))),
        Effect.andThen(fs.chmod(tmp, 0o600)),
        Effect.andThen(fs.rename(tmp, file)),
        Effect.onError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)),
      ),
    )
  })

const makeWsProtocol = Effect.gen(function* () {
  const serialization = RpcSerialization.jsonRpc()
  const encodeDefectUnsafe = Schema.encodeSync(serialization.codecFor(Schema.Defect()))
  const disconnects = yield* Queue.make<number>()
  let nextClientId = 0

  const clients = new Map<
    number,
    {
      readonly write: (response: RpcMessage.FromServerEncoded) => Effect.Effect<void>
      readonly close: () => Effect.Effect<void>
    }
  >()

  const clientIds = new Set<number>()
  let writeRequest: (clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void> = () => Effect.void

  const onSocket = Effect.fnUntraced(function* (
    socket: Socket.Socket,
    headers: ReadonlyArray<readonly [string, string]>,
  ) {
    const scope = yield* Effect.scope
    const parser = serialization.makeUnsafe()
    const id = nextClientId++
    yield* Scope.addFinalizerExit(scope, () => {
      clients.delete(id)
      clientIds.delete(id)

      return Queue.offer(disconnects, id)
    })

    const writer = yield* socket.writer

    const writeEncoded = (encoded: string | Uint8Array | undefined) => {
      if (encoded === undefined) return Effect.void

      const frame = Predicate.isString(encoded) ? encoded : textDecoder.decode(encoded)

      return Effect.orDie(writer.write(frame))
    }

    const write = (response: RpcMessage.FromServerEncoded) => {
      try {
        return writeEncoded(parser.encode(response))
      } catch (cause) {
        return writeEncoded(parser.encode(RpcMessage.ResponseDefectEncoded(encodeDefectUnsafe(cause))))
      }
    }

    const close = () => writer.write(new Socket.CloseEvent(1001, "server shutting down")).pipe(Effect.ignore)

    clients.set(id, { write, close })
    clientIds.add(id)

    const processData = (data: string | Uint8Array): Effect.Effect<void> => {
      try {
        const decoded = parser.decode(data)

        if (decoded.length === 0) return Effect.void

        return Effect.forEach(
          decoded,
          (raw) => {
            const parsed = decodeRpcMessage(raw)

            if (Option.isNone(parsed)) return Effect.void
            const message = parsed.value

            if (Predicate.isTagged(message, "Request")) {
              const merged: Array<[string, string]> = [
                ...headers.map(([k, v]): [string, string] => [k, v]),
                ...message.headers.map(([k, v]): [string, string] => [k, v]),
              ]

              const payload =
                message.tag === "Watch" &&
                Predicate.isObject(message.payload) &&
                !Array.isArray(message.payload) &&
                Object.keys(message.payload).length === 0
                  ? null
                  : message.payload

              const request = ClientMessages.Request({
                id: RpcMessage.RequestId(message.id),
                tag: message.tag,
                payload,
                headers: merged,
                ...(message.isNotification !== undefined && { isNotification: message.isNotification }),
                ...(message.traceId !== undefined && { traceId: message.traceId }),
                ...(message.spanId !== undefined && { spanId: message.spanId }),
                ...(message.sampled !== undefined && { sampled: message.sampled }),
              })

              return writeRequest(id, request)
            }

            if (Predicate.isTagged(message, "Ack")) {
              return writeRequest(id, ClientMessages.Ack({ requestId: RpcMessage.RequestId(message.requestId) }))
            }

            if (Predicate.isTagged(message, "Interrupt")) {
              return writeRequest(id, ClientMessages.Interrupt({ requestId: RpcMessage.RequestId(message.requestId) }))
            }

            if (Predicate.isTagged(message, "Ping")) {
              return writeRequest(id, RpcMessage.constPing)
            }

            if (Predicate.isTagged(message, "Eof")) {
              return writeRequest(id, RpcMessage.constEof)
            }

            return Effect.void
          },
          { discard: true },
        )
      } catch (cause) {
        if (Predicate.isTagged(cause, "MaxBufferSizeExceeded")) {
          return Effect.orDie(writer.write(new Socket.CloseEvent(1009, String(cause))))
        }

        return writeEncoded(parser.encode(RpcMessage.ResponseDefectEncoded(encodeDefectUnsafe(cause))))
      }
    }

    yield* Effect.gen(function* () {
      const { pull } = yield* socket.reader

      while (true) {
        const frames = yield* pull

        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i]

          if (frame !== undefined) yield* processData(frame)
        }
      }
    }).pipe(
      Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
      Effect.tapCause((cause) => Effect.logError("local WebSocket connection failed", cause)),
      Effect.orDie,
    )
  })

  const protocol = yield* RpcServer.Protocol.make((writeRequest_) => {
    writeRequest = writeRequest_

    return Effect.succeed({
      disconnects,
      send: (clientId, response) => {
        const client = clients.get(clientId)

        if (!client) return Effect.void

        return Effect.orDie(client.write(response))
      },
      end: () => Effect.void,
      clientIds: Effect.sync(() => clientIds),
      initialMessage: Effect.succeedNone,
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: serialization.codecFor,
    })
  })

  const closeAll = Effect.suspend(() =>
    Effect.forEach(Array.from(clients.values()), (client) => client.close(), { discard: true }),
  )

  return { protocol, onSocket, closeAll }
})

export const WsCallerGateLive = Layer.succeed(
  CallerGate,
  CallerGate.of((effect, { rpc }) => {
    if (!UI_WS_CALLS.has(rpc._tag)) {
      return Effect.fail(
        new Forbidden({
          method: rpc._tag,
          message: `${rpc._tag} is not available on the local WebSocket`,
        }),
      )
    }

    return Effect.provideService(effect, Caller, Callers.Ui())
  }),
)

export class WsServerLayer extends Context.Service<WsServerLayer, Layer.Layer<HttpServer.HttpServer, ServeError>>()(
  "vibest/WsServerLayer",
) {}

export const wsServerLayer = LayerNode.unbound(WsServerLayer)

const wsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem

    if (!(yield* wsEnabled)) {
      yield* fs.remove(layout.wsInfo, { force: true }).pipe(Effect.ignore)

      return Layer.empty
    }

    const wsServer = yield* WsServerLayer
    const { version } = yield* App.Service
    const identity = yield* DaemonHandlers.Identity
    const pid = identity.pid ?? 0
    const token = randomHex(32)
    const expectedToken = textEncoder.encode(token)

    const protocolAndHandler = Effect.gen(function* () {
      const { protocol, onSocket, closeAll } = yield* makeWsProtocol

      const httpApp = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest

        if (Option.isSome(Headers.get(request.headers, "origin"))) {
          return HttpServerResponse.jsonUnsafe({ error: "browser origin refused" }, { status: 403 })
        }

        const provided = Option.getOrUndefined(Headers.get(request.headers, TOKEN_HEADER))

        if (!tokenMatches(expectedToken, provided)) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid vibest-token" }, { status: 401 })
        }

        const socket = yield* request.upgrade
        yield* onSocket(socket, Object.entries(request.headers))

        return HttpServerResponse.empty()
      })

      return { protocol, httpApp, closeAll }
    })

    return Layer.unwrap(
      Effect.map(protocolAndHandler, ({ protocol, httpApp, closeAll }) => {
        const publish = Layer.effectDiscard(
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer

            if (!NetAddress.isInetAddress(server.address)) {
              return yield* Effect.die(new Error("local WebSocket server must bind a TCP loopback address"))
            }

            const port = server.address.port

            const info: WsInfo = {
              url: `ws://127.0.0.1:${port}`,
              port,
              token,
              protocol: PROTOCOL,
              version,
              pid,
            }

            yield* writePrivateFile(layout.wsInfo, Schema.encodeSync(WsInfoJson)(info), pid)
            yield* Effect.addFinalizer(() =>
              closeAll.pipe(Effect.andThen(fs.remove(layout.wsInfo, { force: true }).pipe(Effect.ignore))),
            )
          }),
        )

        const rpcLayer = RpcServer.layer(VibestRpcs).pipe(
          Layer.provide(Layer.mergeAll(handlersCore, AdmissionLive)),
          Layer.provide(WsCallerGateLive),
          Layer.provide(ProtocolGateLive),
          Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        )

        const served = publish.pipe(Layer.provideMerge(HttpServer.serve(httpApp)))

        return Layer.mergeAll(served, rpcLayer).pipe(Layer.provide(wsServer))
      }),
    )
  }),
)

export const layer = wsLayer.pipe(Layer.provide(WatchFeed.layer.pipe(Layer.provideMerge(Listing.layer))))

export const node = LayerNode.make({
  name: "vibest/WsServer",
  layer: wsLayer,
  deps: [
    services,
    Agents.node,
    Bus.node,
    Concurrency.node,
    Starts.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    DaemonHandlers.identityNode,
    Inbox.node,
    Integration.node,
    EntrySession.node,
    Listing.node,
    Load.node,
    Machines.node,
    Peer.node,
    Plugins.node,
    pluginLoaderNode,
    Processes.node,
    Project.node,
    Remote.node,
    Runtimes.node,
    Session.node,
    DaemonHandlers.shutdownNode,
    RepositoryUrl.node,
    Subscriptions.node,
    UpdateCheck.node,
    WatchFeed.node,
    App.node,
    Identity.node,
    wsServerLayer,
    PlatformNode.childProcessSpawner,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
