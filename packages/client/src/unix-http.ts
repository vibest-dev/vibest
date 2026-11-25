import { Context, Effect, Inspectable, Option, Pipeable, Predicate, Stream } from "effect"
import {
  Cookies,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
  UrlParams,
} from "effect/http"

export * as HttpConnector from "./unix-http.ts"

export type Interface = (socket: string) => HttpClient.HttpClient

export class Service extends Context.Service<Service, Interface>()("vibest/HttpConnector") {}

export const RequestHeaders = Context.Reference<Readonly<Record<string, string>>>("vibest/RequestHeaders", {
  defaultValue: () => ({}),
})

export const withHeaders = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  headers: Readonly<Record<string, string>>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, RequestHeaders, headers)

export const withStreamHeaders = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  headers: Readonly<Record<string, string>>,
): Stream.Stream<A, E, R> => Stream.provideService(stream, RequestHeaders, headers)

export const applyRequestHeaders = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.mapRequestEffect(client, (request) =>
    Effect.map(RequestHeaders, (extra) => {
      const entries = Object.entries(extra)

      return entries.length === 0 ? request : HttpClientRequest.setHeaders(request, extra)
    }),
  )

export const encodeBody = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Uint8Array | undefined, HttpClientError.HttpClientError> => {
  const body = request.body

  if (Predicate.isTagged(body, "Empty")) return Effect.succeed(undefined)

  if (Predicate.isTagged(body, "Uint8Array")) return Effect.succeed(body.body)

  if (Predicate.isTagged(body, "Stream"))
    return Stream.runCollect(body.stream).pipe(
      Effect.map((chunks) => {
        const list = [...chunks]
        const total = list.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        const merged = new Uint8Array(total)
        let offset = 0

        for (const chunk of list) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }

        return merged
      }),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({ request, cause }),
          }),
      ),
    )

  if (Predicate.isTagged(body, "Raw")) {
    if (body.body instanceof Uint8Array) return Effect.succeed(body.body)

    if (Predicate.isString(body.body)) return Effect.succeed(new TextEncoder().encode(body.body))
  }

  return Effect.succeed(undefined)
}

export const requestHeadersRecord = (request: HttpClientRequest.HttpClientRequest) => {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(request.headers)) {
    if (Predicate.isString(value)) out[key] = value
  }

  const body = request.body

  if (
    !Predicate.isTagged(body, "Empty") &&
    Predicate.hasProperty(body, "contentType") &&
    Predicate.isString(body.contentType) &&
    out["content-type"] === undefined
  )
    out["content-type"] = body.contentType

  return out
}

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return merged
}

declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

const textDecoder = new TextDecoder()

export const buildStreamResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  rawHeaders: ReadonlyArray<readonly [string, string]>,
  bodyStream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
): HttpClientResponse.HttpClientResponse => {
  const headers = Headers.fromInput(rawHeaders)
  const readBytes = Stream.runCollect(bodyStream).pipe(Effect.map((chunks) => concatBytes([...chunks])))
  const text = Effect.map(readBytes, (bytes) => textDecoder.decode(bytes))

  const json = Effect.flatMap(text, (str) =>
    Effect.try({
      try: () => JSON.parse(str),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request, response, cause }),
        }),
    }),
  )

  const urlParamsBody = Effect.flatMap(text, (str) =>
    Effect.try({
      try: () =>
        UrlParams.fromInput(
          str
            .split("&")
            .filter((part) => part !== "")
            .map((part) => {
              const eq = part.indexOf("=")

              return eq === -1
                ? ([decodeURIComponent(part), ""] as const)
                : ([decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1))] as const)
            }),
        ),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request, response, cause }),
        }),
    }),
  )

  const arrayBuffer = Effect.map(readBytes, (bytes) => {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)

    return copy.buffer
  })

  const response: HttpClientResponse.HttpClientResponse = {
    [HttpClientResponse.TypeId]: HttpClientResponse.TypeId,
    [HttpIncomingMessage.TypeId]: HttpIncomingMessage.TypeId,
    request,
    url: request.url,
    status,
    headers,
    cookies: Cookies.empty,
    remoteAddress: Option.none(),
    text,
    json,
    urlParamsBody,
    arrayBuffer,
    formData: Effect.suspend(() =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({ request, response, cause: new Error("formData unsupported") }),
        }),
      ),
    ),
    stream: bodyStream,
    upgrade: Effect.suspend(() =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({ request, response, description: "upgrade unsupported" }),
        }),
      ),
    ),
    toJSON() {
      return { _id: "HttpClientResponse", status, headers }
    },
    toString() {
      return JSON.stringify(this.toJSON())
    },
    [Inspectable.NodeInspectSymbol]() {
      return this.toJSON()
    },
    pipe() {
      return Pipeable.pipeArguments(this, arguments)
    },
  }

  return response
}
