import { App } from "@vibest/core/app"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { PlatformNode } from "@vibest/core/effect/platform"
import { PluginLoader, pluginLoaderNode } from "@vibest/core/plugin"
import { UI_WS_CALLS } from "@vibest/protocol/access"
import { PROTOCOL_HEADER, protocolMismatch, TOKEN_HEADER } from "@vibest/protocol/protocol"
import {
  Caller,
  CallerGate,
  type CallerIdentity,
  Forbidden,
  ProtocolGate,
  ProtocolRejected,
} from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { Cause, Config, Context, Data, Deferred, Effect, FileSystem, Layer, Option, Predicate, Schema } from "effect"
import { Hex } from "effect/encoding"
import * as Headers from "effect/http/Headers"
import * as HttpServer from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as NetAddress from "effect/net/NetAddress"
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc"

import { AdmissionLive } from "./gates.ts"
import { group } from "./handlers/group.ts"
import { admissionNode, handlers, handlersNode } from "./server.ts"

export const WsEndpoint = Schema.Struct({
  url: Schema.String,
  port: Schema.Number,
  token: Schema.String,
  protocol: Schema.Number,
})

export type WsEndpoint = typeof WsEndpoint.Type

export class Service extends Context.Service<Service, Option.Option<WsEndpoint>>()("vibest/Ws") {}

const WsConfigFile = Schema.Struct({
  websocket: Schema.optional(Schema.Boolean),
})

const WsRpcs = group([
  "Watch",
  "Launch",
  "Project.Open",
  "Project.Create",
  "Send",
  "Session.Link",
  "Session.Unlink",
  "Interrupt",
  "Stop",
  "Archive",
  "Peek",
  "Get",
  "Session.Seen",
  "Machine.List",
  "Harnesses.List",
  "Agents.List",
])

const MAX_FRAME_BYTES = 64 * 1024

class MaxBufferSizeExceeded extends Data.TaggedError("MaxBufferSizeExceeded")<{ readonly message: string }> {}

type RpcExitEncoded = Extract<RpcMessage.FromServerEncoded, { readonly _tag: "Exit" }>["exit"]

type RpcFailureReason = Extract<RpcExitEncoded, { readonly _tag: "Failure" }>["cause"][number]

const decodeWsConfig = Schema.decodeUnknownOption(WsConfigFile)
const Callers = Data.taggedEnum<CallerIdentity>()
const ServerMessages = Data.taggedEnum<RpcMessage.FromServerEncoded>()
const RpcExits = Data.taggedEnum<RpcExitEncoded>()
const RpcReasons = Data.taggedEnum<RpcFailureReason>()

const baseSerialization = RpcSerialization.jsonRpc()
const encodeForbidden = Schema.encodeSync(Forbidden)

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

const HeaderPairSchema = Schema.Tuple([Schema.String, Schema.String])
const decodeHeaderPairs = Schema.decodeUnknownOption(Schema.Array(HeaderPairSchema))

const RawRpcFrameSchema = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  headers: Schema.optional(Schema.Unknown),
})

const decodeRawRpcFrame = Schema.decodeUnknownOption(RawRpcFrameSchema)

const wsSerialization = RpcSerialization.RpcSerialization.of({
  ...baseSerialization,
  makeUnsafe: () => {
    const parser = baseSerialization.makeUnsafe()

    return {
      encode: (response) => parser.encode(response),
      decode: (data) => {
        const byteLength = Predicate.isString(data) ? textEncoder.encode(data).byteLength : data.byteLength

        if (byteLength > MAX_FRAME_BYTES) {
          throw new MaxBufferSizeExceeded({ message: `WebSocket frame exceeds ${MAX_FRAME_BYTES} bytes` })
        }

        const text = Predicate.isString(data) ? data : textDecoder.decode(data)
        const parsed: unknown = JSON.parse(text)

        if (Array.isArray(parsed) || !Predicate.isObject(parsed)) {
          throw new Error("WebSocket frame must be a single JSON-RPC object")
        }

        const frame = decodeRawRpcFrame(parsed)

        if (Option.isNone(frame)) {
          throw new Error("Invalid JSON-RPC frame")
        }

        const rawHeaders = decodeHeaderPairs(frame.value.headers)

        const filteredHeaders = Option.isSome(rawHeaders)
          ? rawHeaders.value.filter(([key]) => key.toLowerCase() === PROTOCOL_HEADER)
          : []

        const normalizedParams =
          (frame.value.method === "Watch" || frame.value.method === "Machine.List") &&
          Predicate.isObject(frame.value.params) &&
          !Array.isArray(frame.value.params) &&
          Object.keys(frame.value.params).length === 0
            ? null
            : frame.value.params

        const sanitized = {
          ...parsed,
          headers: filteredHeaders,
          ...(frame.value.params !== undefined && { params: normalizedParams }),
        }

        return parser.decode(JSON.stringify(sanitized))
      },
    }
  },
})

export const WsProtocolGateLive = Layer.effect(
  ProtocolGate,
  Effect.gen(function* () {
    const { version } = yield* App.Service

    return ProtocolGate.of((effect, { headers, rpc }) => {
      const sent = Option.getOrUndefined(Headers.get(headers, PROTOCOL_HEADER))

      if (sent === String(PROTOCOL)) return effect

      return Effect.fail(
        new ProtocolRejected({
          method: rpc._tag,
          protocol: sent ?? null,
          mismatch: protocolMismatch(sent === undefined ? undefined : Number(sent), PROTOCOL, version, undefined),
        }),
      )
    })
  }),
)

export const WsCallerGateLive = Layer.succeed(
  CallerGate,
  CallerGate.of((effect, { rpc }) =>
    UI_WS_CALLS.has(rpc._tag)
      ? Effect.provideService(effect, Caller, Callers.Ui())
      : Effect.fail(
          new Forbidden({
            method: rpc._tag,
            message: `${rpc._tag} is not available on the local WebSocket`,
          }),
        ),
  ),
)

export class WsServerLayer extends Context.Service<WsServerLayer, Layer.Layer<HttpServer.HttpServer, ServeError>>()(
  "vibest/WsServerLayer",
) {}

export const wsServerLayer = LayerNode.unbound(WsServerLayer)

const wsLayer = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* wsEnabled)) {
      return Layer.succeed(Service, Option.none())
    }

    const wsServer = yield* WsServerLayer
    const token = randomHex(32)
    const expectedToken = textEncoder.encode(token)
    const ready = yield* Deferred.make<void>()
    let closing = false

    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket.pipe(
      Effect.provideService(RpcSerialization.RpcSerialization, wsSerialization),
    )

    const wrappedProtocol = RpcServer.Protocol.of({
      ...protocol,
      supportsAck: false,
      run: (writeRequest) =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(
            protocol.run((clientId, message) => {
              if (Predicate.isTagged(message, "Request") && !UI_WS_CALLS.has(message.tag)) {
                const exit = RpcExits.Failure({
                  cause: [
                    RpcReasons.Fail({
                      error: encodeForbidden(
                        new Forbidden({
                          method: message.tag,
                          message: `${message.tag} is not available on the local WebSocket`,
                        }),
                      ),
                    }),
                  ],
                })

                return protocol.send(clientId, ServerMessages.Exit({ requestId: message.id, exit }))
              }

              return writeRequest(clientId, message)
            }),
          ),
        ),
    })

    const httpApp = Effect.gen(function* () {
      if (closing) {
        return HttpServerResponse.jsonUnsafe({ error: "server shutting down" }, { status: 503 })
      }

      const request = yield* HttpServerRequest.HttpServerRequest

      if (Option.isSome(Headers.get(request.headers, "origin"))) {
        return HttpServerResponse.jsonUnsafe({ error: "browser origin refused" }, { status: 403 })
      }

      const provided = Option.getOrUndefined(Headers.get(request.headers, TOKEN_HEADER))

      if (!tokenMatches(expectedToken, provided)) {
        return HttpServerResponse.jsonUnsafe({ error: "invalid vibest-token" }, { status: 401 })
      }

      yield* Deferred.await(ready)

      const proto = Option.getOrUndefined(Headers.get(request.headers, PROTOCOL_HEADER))
      const sanitizedHeaders = Headers.fromInput(proto !== undefined ? [[PROTOCOL_HEADER, proto]] : [])

      return yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request.modify({ headers: sanitizedHeaders })),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("local WebSocket connection failed", cause),
        ),
      )
    })

    const endpoint = Layer.effect(
      Service,
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer

        if (!NetAddress.isInetAddress(server.address) || server.address.address.toString() !== "127.0.0.1") {
          return yield* Effect.die(new Error("local WebSocket server must bind 127.0.0.1"))
        }

        yield* Deferred.await(ready)

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closing = true
          }),
        )

        const port = server.address.port

        return Option.some({
          url: `ws://127.0.0.1:${port}`,
          port,
          token,
          protocol: PROTOCOL,
        })
      }),
    )

    const rpcLayer = RpcServer.layer(WsRpcs).pipe(
      Layer.provide(WsCallerGateLive),
      Layer.provide(WsProtocolGateLive),
      Layer.provide(Layer.succeed(RpcServer.Protocol, wrappedProtocol)),
    )

    const served = endpoint.pipe(Layer.provideMerge(HttpServer.serve(httpApp)))

    return Layer.mergeAll(served, rpcLayer).pipe(Layer.provide(wsServer))
  }),
)

export const layer = wsLayer.pipe(Layer.provide(Layer.mergeAll(handlers, AdmissionLive)))

export const node = LayerNode.make({
  service: Service,
  layer: wsLayer,
  deps: [
    handlersNode,
    admissionNode,
    pluginLoaderNode,
    App.node,
    wsServerLayer,
    PlatformNode.fileSystem,
    PlatformNode.layout,
  ],
})
