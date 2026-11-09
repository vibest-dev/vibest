import { Cause, Config, Context, Effect, Layer, Option, type Path, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import { GENERATION, METHODS, MIN_VERSION, type SubscribeResult } from "./generated/api.js"
import { SocketConnector } from "./socket-connector.js"
import { defaultSocketPath } from "./socket-path.js"

export type Method = keyof typeof METHODS
export type ParamsOf<M extends Method> = (typeof METHODS)[M]["params"]["Encoded"]
export type ResultOf<M extends Method> = (typeof METHODS)[M]["result"]["Type"]

export class HcError extends Schema.TaggedError<HcError>()("HcError", {
  method: Schema.String,
  kind: Schema.String,
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

export class HcTransportError extends Schema.TaggedError<HcTransportError>()("HcTransportError", {
  method: Schema.String,
  message: Schema.String,
}) {}

export type HcFailure = HcError | HcTransportError

export class HcGenerationMismatch extends Schema.TaggedError<HcGenerationMismatch>()("HcGenerationMismatch", {
  socketPath: Schema.String,
  expected: Schema.Number,
  message: Schema.String,
}) {}

export class HcCoreTooOld extends Schema.TaggedError<HcCoreTooOld>()("HcCoreTooOld", {
  socketPath: Schema.String,
  version: Schema.String,
  minimum: Schema.String,
  message: Schema.String,
}) {}

export class HcMethodsMissing extends Schema.TaggedError<HcMethodsMissing>()("HcMethodsMissing", {
  socketPath: Schema.String,
  missing: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export type HcIncompatible = HcGenerationMismatch | HcCoreTooOld | HcMethodsMissing

export const USED_METHODS: ReadonlyArray<Method> = [
  "events.subscribe",
  "machine.add",
  "machine.list",
  "machine.rm",
  "terminal.get",
  "terminal.keys",
  "terminal.kill",
  "terminal.label",
  "terminal.list",
  "terminal.read",
  "terminal.rm",
  "terminal.run",
  "terminal.send",
]

const semver = (v: string): ReadonlyArray<number> =>
  v
    .trim()
    .replace(/^hc /, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0)

const olderThan = (a: string, b: string): boolean => {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

export const HcEvent = Schema.Struct({
  type: Schema.String,
  seq: Schema.Number,
  terminal: Schema.String,
  data: Schema.optional(Schema.Unknown),
})
export type HcEvent = typeof HcEvent.Type

export type Notice =
  | { readonly _tag: "Subscribed"; readonly result: SubscribeResult }
  | { readonly _tag: "Event"; readonly event: HcEvent }
  | { readonly _tag: "Notification"; readonly method: string; readonly params: unknown }

export interface HcShape {
  readonly socketPath: string
  readonly call: <M extends Method>(method: M, params: ParamsOf<M>) => Effect.Effect<ResultOf<M>, HcFailure>
  readonly hello: Effect.Effect<ResultOf<"hello">, HcFailure | HcIncompatible>
  readonly subscribe: (params: ParamsOf<"events.subscribe">) => Stream.Stream<Notice, HcFailure>
}

export class Hc extends Context.Service<Hc, HcShape>()("effect-herdr-core-sdk/Hc") {
  static readonly make = (socketPath: string): Effect.Effect<HcShape, never, SocketConnector> =>
    Effect.map(SocketConnector, (connect) => makeClient(socketPath, connect))
  static readonly layer = (
    options: { readonly socketPath?: string } = {},
  ): Layer.Layer<Hc, Config.ConfigError, SocketConnector | Path.Path> =>
    Layer.effect(
      Hc,
      (options.socketPath !== undefined ? Effect.succeed(options.socketPath) : defaultSocketPath()).pipe(
        Effect.flatMap(Hc.make),
      ),
    )
}

const ErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Struct({ kind: Schema.optional(Schema.String), hint: Schema.optional(Schema.String) })),
})
const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(ErrorBody),
})
type Message = typeof Message.Type
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Message))
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeEvent = Schema.decodeUnknownEffect(HcEvent)

let nextId = 0

function makeClient(socketPath: string, connect: SocketConnector["Service"]): HcShape {
  const transport = (method: string) => (e: { readonly message: string }) =>
    new HcTransportError({ method, message: e.message })
  const serverError = (method: string, error: typeof ErrorBody.Type) =>
    new HcError({
      method,
      kind: error.data?.kind ?? String(error.code),
      message: error.message,
      ...(error.data?.hint !== undefined ? { hint: error.data.hint } : {}),
    })

  const open = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = ++nextId
      const socket = yield* connect(socketPath)
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      yield* writer.write(`${yield* encodeLine({ jsonrpc: "2.0", id, method, params }).pipe(Effect.orDie)}\n`)
      const text = pull.pipe(
        Effect.catchIf(
          (e) => e.reason._tag === "SocketCloseError",
          () => Cause.done(),
        ),
      )
      const lines = Stream.fromPull(Effect.succeed(text)).pipe(
        Stream.splitLines,
        Stream.filter((l) => l.length > 0),
        Stream.mapEffect((line) => decodeLine(line)),
        Stream.mapError(transport(method)),
      )
      return { id, lines }
    }).pipe(Effect.mapError(transport(method)))

  const response = (method: string, id: number) => (m: Message) =>
    m.method === undefined && (m.id === id || m.id === null)

  const decodeResult = <M extends Method>(method: M, raw: unknown) =>
    Schema.decodeUnknownEffect(METHODS[method].result as Schema.Codec<ResultOf<M>>)(raw).pipe(
      Effect.mapError((e) => new HcTransportError({ method, message: `the result does not match hc schema: ${e}` })),
    )

  const call = <M extends Method>(method: M, params: ParamsOf<M>) =>
    Effect.gen(function* () {
      const { id, lines } = yield* open(method, params)
      const found = yield* lines.pipe(Stream.filter(response(method, id)), Stream.runHead)
      if (Option.isNone(found))
        return yield* new HcTransportError({ method, message: "connection closed before a response" })
      if (found.value.error) return yield* serverError(method, found.value.error)
      return yield* decodeResult(method, found.value.result)
    }).pipe(Effect.scoped)

  const hello = call("hello", {}).pipe(
    Effect.flatMap((r): Effect.Effect<ResultOf<"hello">, HcIncompatible> => {
      const core = `herdr-core ${r.version}`
      if (r.generation > GENERATION)
        return Effect.fail(
          new HcGenerationMismatch({
            socketPath,
            expected: GENERATION,
            message: `${core} speaks protocol generation ${r.generation}, vibest speaks ${GENERATION}: update vibest`,
          }),
        )
      if (r.generation < GENERATION)
        return Effect.fail(
          new HcGenerationMismatch({
            socketPath,
            expected: GENERATION,
            message: `${core} speaks protocol generation ${r.generation}, vibest needs ${GENERATION}: update herdr-core`,
          }),
        )
      if (olderThan(r.version, MIN_VERSION))
        return Effect.fail(
          new HcCoreTooOld({
            socketPath,
            version: r.version,
            minimum: MIN_VERSION,
            message: `${core} is older than the minimum ${MIN_VERSION} vibest needs: update herdr-core`,
          }),
        )
      const missing = USED_METHODS.filter((m) => !r.methods.includes(m))
      return missing.length === 0
        ? Effect.succeed(r)
        : Effect.fail(
            new HcMethodsMissing({
              socketPath,
              missing,
              message: `${core} lacks methods vibest calls (${missing.join(", ")}): update herdr-core`,
            }),
          )
    }),
  )

  const subscribe = (params: ParamsOf<"events.subscribe">): Stream.Stream<Notice, HcFailure> => {
    const method = "events.subscribe"
    return Effect.gen(function* () {
      const { id, lines } = yield* open(method, params)
      return lines.pipe(
        Stream.mapEffect((m): Effect.Effect<Notice, HcFailure> => {
          if (response(method, id)(m))
            return m.error
              ? Effect.fail(serverError(method, m.error))
              : decodeResult(method, m.result).pipe(Effect.map((result) => ({ _tag: "Subscribed" as const, result })))
          if (m.method === "event")
            return decodeEvent(m.params).pipe(
              Effect.map((event) => ({ _tag: "Event" as const, event })),
              Effect.mapError(transport(method)),
            )
          return Effect.succeed({ _tag: "Notification" as const, method: m.method ?? "", params: m.params })
        }),
      )
    }).pipe(Stream.unwrap)
  }

  return { socketPath, call, hello, subscribe }
}

export const fromEnv = (): Effect.Effect<HcShape, Config.ConfigError, SocketConnector | Path.Path> =>
  defaultSocketPath().pipe(Effect.flatMap(Hc.make))
