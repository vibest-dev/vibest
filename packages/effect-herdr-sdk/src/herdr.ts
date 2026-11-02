// Effect-native client for the herdr socket API.
// Wire facts (herdr 0.9, protocol 22): newline-delimited JSON; `{id, method, params}` → `{id, result}` | `{id, error}`;
// the server closes after one response, so every call is its own connection. `events.subscribe` acks with
// `subscription_started` and then keeps the connection open, streaming `{event, data}` frames.
import { Cause, Config, Context, Effect, Layer, Option, type Path, Random, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import type { PushFrame } from "./generated/events.js"
import { PROTOCOL } from "./generated/index.js"
import type { Method, MethodParams, Subscription } from "./generated/params.js"
import type { METHOD_RESULT, ResponseResult, ResultByTag } from "./generated/results.js"
import { SocketConnector } from "./socket-connector.js"
import { defaultSocketPath, socketEndpoint, type SocketPathOptions } from "./socket-path.js"

export type ResultOf<M extends Method> = M extends keyof typeof METHOD_RESULT
  ? ResultByTag[(typeof METHOD_RESULT)[M]]
  : ResponseResult
export type ParamsOf<M extends Method> = MethodParams[M]

/** The server answered `{ error }`. `code` is herdr's machine-readable code (`timeout`, `agent_pane_busy`, …). */
export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/** Socket missing, refused, or closed before a response. */
export class HerdrTransportError extends Schema.TaggedError<HerdrTransportError>()("HerdrTransportError", {
  method: Schema.String,
  message: Schema.String,
}) {}

export type HerdrFailure = HerdrError | HerdrTransportError

/** The server speaks a different protocol than the one this SDK's types were generated for (`PROTOCOL`). */
export class HerdrProtocolMismatch extends Schema.TaggedError<HerdrProtocolMismatch>()("HerdrProtocolMismatch", {
  socketPath: Schema.String,
  expected: Schema.Number,
  actual: Schema.Number,
  serverVersion: Schema.String,
}) {}

export interface HerdrShape {
  readonly socketPath: string
  readonly call: <M extends Method>(method: M, params: ParamsOf<M>) => Effect.Effect<ResultOf<M>, HerdrFailure>
  /** Long-lived push stream. Ends when the server closes the connection. */
  readonly subscribe: (subscriptions: ReadonlyArray<Subscription>) => Stream.Stream<PushFrame, HerdrFailure>
}

export class Herdr extends Context.Service<Herdr, HerdrShape>()("effect-herdr-sdk/Herdr") {
  /**
   * The handshake every consumer runs before trusting a server: the generated types (and the unchecked casts that
   * hand them out, see `call` / `subscribe`) are only true for the protocol they were generated from.
   */
  static readonly verifyProtocol = (herdr: HerdrShape): Effect.Effect<void, HerdrFailure | HerdrProtocolMismatch> =>
    herdr.call("ping", {}).pipe(
      Effect.flatMap((pong) =>
        pong.protocol === PROTOCOL
          ? Effect.void
          : Effect.fail(
              new HerdrProtocolMismatch({
                socketPath: herdr.socketPath,
                expected: PROTOCOL,
                actual: pong.protocol,
                serverVersion: pong.version,
              }),
            ),
      ),
    )

  /** A client for `socketPath`, dialing through the provided `SocketConnector`. */
  static readonly make = (socketPath: string): Effect.Effect<HerdrShape, never, SocketConnector> =>
    Effect.map(SocketConnector, (connect) => makeClient(socketPath, connect))
  /** Socket from `options.socketPath`, else herdr's own resolution (HERDR_SOCKET_PATH, XDG_CONFIG_HOME, HOME …) read through Config. */
  static readonly layer = (
    options: { socketPath?: string } & SocketPathOptions = {},
  ): Layer.Layer<Herdr, Config.ConfigError, SocketConnector | Path.Path> =>
    Layer.effect(
      Herdr,
      (options.socketPath ? Effect.succeed(options.socketPath) : defaultSocketPath(options)).pipe(
        Effect.flatMap(Herdr.make),
      ),
    )
}

// Wire frames (herdr protocol 22). `id: ""` = the server could not parse our request; still ours.
const Response = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
const Push = Schema.Struct({ event: Schema.String, data: Schema.Unknown })
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Union([Response, Push])))
const Request = Schema.Struct({ id: Schema.String, method: Schema.String, params: Schema.Unknown })
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Request))
const isResponse = (m: typeof Response.Type | typeof Push.Type): m is typeof Response.Type => "id" in m

const requestId = (prefix: string) =>
  Random.nextIntBetween(0, 2 ** 31).pipe(Effect.map((n) => `${prefix}-${n.toString(36)}`))

function makeClient(socketPath: string, connect: SocketConnector["Service"]): HerdrShape {
  const transport = (method: string) => (e: { readonly message: string }) =>
    new HerdrTransportError({ method, message: e.message })
  const serverError = (method: string, error: { code: string; message: string }) =>
    new HerdrError({ method, code: error.code, message: error.message })

  /** Open a connection, send one request line, and expose the decoded response lines. Scoped: closing the scope closes the socket. */
  const open = (method: string, request: typeof Request.Type) =>
    Effect.gen(function* () {
      const socket = yield* connect(socketEndpoint(socketPath))
      // Acquiring the reader dials; the writer waits on that, so writing first would hang forever.
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      yield* writer.write(`${yield* encodeRequest(request).pipe(Effect.orDie)}\n`)
      // Every close surfaces as a SocketError; a clean close is just the end of the stream.
      const text = pull.pipe(
        Effect.catchIf(
          (e) => e.reason._tag === "SocketCloseError",
          () => Cause.done(),
        ),
      )
      return Stream.fromPull(Effect.succeed(text)).pipe(
        Stream.splitLines,
        Stream.filter((l) => l.length > 0),
        Stream.mapEffect((line) => decodeLine(line)),
        Stream.mapError(transport(method)),
      )
    }).pipe(Effect.mapError(transport(method)))

  const call = <M extends Method>(method: M, params: ParamsOf<M>) =>
    Effect.gen(function* () {
      const id = yield* requestId("vibest")
      const lines = yield* open(method, { id, method, params })
      const found = yield* lines.pipe(
        Stream.filter(isResponse),
        Stream.filter((m) => m.id === id || m.id === ""),
        Stream.runHead,
      )
      if (Option.isNone(found))
        return yield* new HerdrTransportError({ method, message: "connection closed before a response" })
      if (found.value.error) return yield* serverError(method, found.value.error)
      // Not decoded at runtime: the shape is herdr's contract for PROTOCOL, checked once per server by verifyProtocol.
      return found.value.result as ResultOf<M>
    }).pipe(Effect.scoped)

  /** herdr acks with a response first and only then pushes frames, so no ack state is needed. */
  const subscribe = (subscriptions: ReadonlyArray<Subscription>): Stream.Stream<PushFrame, HerdrFailure> => {
    const method = "events.subscribe"
    return Effect.gen(function* () {
      const id = yield* requestId("sub")
      const lines = yield* open(method, { id, method, params: { subscriptions } })
      return lines.pipe(
        Stream.flatMap(
          (m): Stream.Stream<PushFrame, HerdrFailure> =>
            isResponse(m)
              ? (m.id === id || m.id === "") && m.error
                ? Stream.fail(serverError(method, m.error))
                : Stream.empty
              : Stream.make(m as PushFrame), // herdr's contract for PROTOCOL, as in `call`
        ),
      )
    }).pipe(Stream.unwrap)
  }

  return { socketPath, call, subscribe }
}
