import { App } from "@vibest/core/app"
import { PluginLoader, pluginLoaderNode } from "@vibest/core/plugin"
import { UI_CALLS } from "@vibest/protocol/access"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden, ProtocolRejected, UnauthorizedError } from "@vibest/protocol/errors"
import { Caller, CallerMiddleware, type CallerIdentity, ProtocolMiddleware } from "@vibest/protocol/middleware"
import { PROTOCOL_HEADER, protocolMismatch, TOKEN_HEADER } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { LayerNode } from "@vibest/util/layer-node"
import { Config, Context, Data, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Hex } from "effect/encoding"
import { Etag, Headers, HttpPlatform, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import type { ServeError } from "effect/http/HttpServerError"
import * as NetAddress from "effect/net/NetAddress"

import { AdmissionLive } from "./gates.ts"
import * as Listing from "./listing.ts"
import { RemoteWatch } from "./machine/remote-watch.ts"
import { defectResponseLayer } from "./middleware/defect-response.ts"
import { schemaErrorLayer } from "./middleware/schema-error.ts"
import { handlerDeps, handlersCore } from "./server.ts"
import { WatchFeed } from "./watch-feed.ts"

export const UiEndpoint = Schema.Struct({
  url: Schema.String,
  port: Schema.Number,
  token: Schema.String,
  protocol: Schema.Number,
})

export type UiEndpoint = typeof UiEndpoint.Type

export class Service extends Context.Service<Service, Option.Option<UiEndpoint>>()("vibest/Ui") {}

const UiConfigFile = Schema.Struct({
  httpUi: Schema.optional(Schema.Boolean),
  websocket: Schema.optional(Schema.Boolean),
})

const decodeUiConfig = Schema.decodeUnknownOption(UiConfigFile)
const Callers = Data.taggedEnum<CallerIdentity>()

declare const crypto: { readonly getRandomValues: (bytes: Uint8Array) => Uint8Array }

const textEncoder = new TextEncoder()

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

const isDisabledEnv = (value: string) => {
  const normalized = value.trim().toLowerCase()

  return normalized === "0" || normalized === "false"
}

const uiEnabled = Effect.gen(function* () {
  const httpUiEnv = yield* Config.option(Config.String("VIBEST_HTTP_UI")).pipe(
    Effect.orElseSucceed(() => Option.none()),
  )

  if (Option.isSome(httpUiEnv) && isDisabledEnv(httpUiEnv.value)) return false

  const wsEnv = yield* Config.option(Config.String("VIBEST_WEBSOCKET")).pipe(Effect.orElseSucceed(() => Option.none()))

  if (Option.isSome(wsEnv) && isDisabledEnv(wsEnv.value)) return false

  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const loader = yield* PluginLoader

  const text = yield* fs.readFileString(layout.config).pipe(Effect.option)

  if (Option.isNone(text)) return true

  const parsed = yield* Effect.try(() => loader.parseJsonc(text.value)).pipe(Effect.option)

  if (Option.isNone(parsed)) return true

  const decoded = decodeUiConfig(parsed.value)

  if (Option.isSome(decoded) && (decoded.value.httpUi === false || decoded.value.websocket === false)) return false

  return true
})

const pathPattern = (routePath: string) =>
  new RegExp(
    `^${routePath
      .split("/")
      .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`,
  )

const allowedUiRoutes: ReadonlyArray<{ readonly method: string; readonly pattern: RegExp }> = (() => {
  const routes: Array<{ readonly method: string; readonly pattern: RegExp }> = []

  HttpApi.reflect(VibestApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      if (UI_CALLS.has(endpoint.identifier)) {
        routes.push({ method: endpoint.method, pattern: pathPattern(endpoint.path) })
      }
    },
  })

  return routes
})()

const isAllowedUiRoute = (method: string, url: string) => {
  const path = url.split("?")[0] ?? ""

  return allowedUiRoutes.some((route) => route.method === method && route.pattern.test(path))
}

export const UiProtocolMiddlewareLive = Layer.effect(
  ProtocolMiddleware,
  Effect.gen(function* () {
    const { version } = yield* App.Service

    return ProtocolMiddleware.of((effect, { endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const sent = Option.getOrUndefined(Headers.get(request.headers, PROTOCOL_HEADER))

        if (sent === String(PROTOCOL)) return yield* effect

        return yield* new ProtocolRejected({
          ...protocolMismatch(sent === undefined ? undefined : Number(sent), PROTOCOL, version, undefined),
          method: endpoint.identifier,
          callerProtocol: sent ?? null,
        })
      }),
    )
  }),
)

export const UiCallerMiddlewareLive = Layer.succeed(
  CallerMiddleware,
  CallerMiddleware.of((effect, { endpoint }) =>
    UI_CALLS.has(endpoint.identifier)
      ? Effect.provideService(effect, Caller, Callers.Ui())
      : Effect.fail(
          new Forbidden({
            method: endpoint.identifier,
            message: `${endpoint.identifier} is not available on the local UI server`,
          }),
        ),
  ),
)

export class UiServerLayer extends Context.Service<UiServerLayer, Layer.Layer<HttpServer.HttpServer, ServeError>>()(
  "vibest/UiServerLayer",
) {}

export const uiServerLayer = LayerNode.unbound(UiServerLayer)

const uiLayer = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* uiEnabled)) {
      return Layer.succeed(Service, Option.none())
    }

    const uiServer = yield* UiServerLayer
    const token = randomHex(32)
    const expectedToken = textEncoder.encode(token)
    let closing = false

    const uiAuthLayer = HttpRouter.middleware(
      (effect) =>
        Effect.gen(function* () {
          if (closing) return HttpServerResponse.jsonUnsafe({ error: "server shutting down" }, { status: 503 })

          const request = yield* HttpServerRequest.HttpServerRequest

          if (Option.isSome(Headers.get(request.headers, "origin")))
            return HttpServerResponse.jsonUnsafe({ error: "browser origin refused" }, { status: 403 })

          const provided = Option.getOrUndefined(Headers.get(request.headers, TOKEN_HEADER))

          if (!tokenMatches(expectedToken, provided))
            return HttpServerResponse.jsonUnsafe(new UnauthorizedError({ message: "invalid vibest-token" }), {
              status: 401,
            })

          if (!isAllowedUiRoute(request.method, request.url))
            return HttpServerResponse.jsonUnsafe(
              new Forbidden({
                method: `${request.method} ${request.url.split("?")[0] ?? ""}`,
                message: "route is not available on the local UI server",
              }),
              { status: 403 },
            )

          const kept: Array<readonly [string, string]> = []

          for (const name of [PROTOCOL_HEADER, "content-type", "accept"]) {
            const val = Option.getOrUndefined(Headers.get(request.headers, name))

            if (val !== undefined) kept.push([name, val])
          }

          return yield* effect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({ headers: Headers.fromInput(kept) }),
            ),
          )
        }),
      { global: true },
    )

    const apiRoutes = HttpApiBuilder.layer(VibestApi).pipe(
      Layer.provide(handlersCore),
      Layer.provide(UiCallerMiddlewareLive),
      Layer.provide(UiProtocolMiddlewareLive),
      Layer.provide(AdmissionLive),
      Layer.provide(schemaErrorLayer),
      Layer.merge(uiAuthLayer),
      Layer.merge(defectResponseLayer),
    )

    const endpoint = Layer.effect(
      Service,
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer

        if (!NetAddress.isInetAddress(server.address) || server.address.address.toString() !== "127.0.0.1") {
          return yield* Effect.die(new Error("local UI HTTP server must bind 127.0.0.1"))
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closing = true
          }),
        )

        const port = server.address.port

        return Option.some({
          url: `http://127.0.0.1:${port}`,
          port,
          token,
          protocol: PROTOCOL,
        })
      }),
    )

    const serveUi = Layer.effectDiscard(
      Effect.gen(function* () {
        const memoMap = yield* Layer.makeMemoMap
        const app = yield* HttpRouter.toHttpEffect(apiRoutes).pipe(Effect.provideService(Layer.CurrentMemoMap, memoMap))
        yield* HttpServer.serveEffect(app)
      }),
    )

    return endpoint.pipe(
      Layer.provideMerge(serveUi),
      Layer.provide(Layer.merge(HttpPlatform.layer, Etag.layerWeak)),
      Layer.provide(uiServer),
    )
  }),
)

export const layer = uiLayer.pipe(
  Layer.provide(Layer.merge(WatchFeed.layer.pipe(Layer.provideMerge(Listing.layer)), RemoteWatch.layer)),
)

export const node = LayerNode.make({
  service: Service,
  layer: uiLayer,
  deps: [...handlerDeps, pluginLoaderNode, uiServerLayer],
})
