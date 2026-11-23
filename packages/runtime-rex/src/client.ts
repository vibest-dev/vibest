import os from "node:os"

import { Deferred, Duration, Effect, Queue, Schema, type Scope, Stream } from "effect"
import * as Socket from "effect/socket/Socket"

import {
  encodeFrame,
  encodeText,
  handshakeKey,
  messageReader,
  OPCODE,
  readUpgrade,
  upgradeRequest,
} from "./protocol.ts"

export class RexError extends Schema.TaggedError<RexError>()("RexError", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

export type Connector = (socketPath: string) => Effect.Effect<Socket.Socket>

export interface Pushed {
  readonly type: string
  readonly payload: unknown
}

export interface Connection {
  readonly revision: number
  readonly call: (method: string, payload: Schema.JsonObject) => Effect.Effect<unknown, RexError>
  readonly pushed: Stream.Stream<Pushed, RexError>
}

const Incoming = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  api_server_revision: Schema.optional(Schema.Number),
})

const decodeIncoming = Schema.decodeUnknownEffect(Schema.fromJsonString(Incoming))

export const API_REVISION = 18

const OPEN_TIMEOUT = Duration.seconds(5)
const CALL_TIMEOUT = Duration.seconds(30)

const concat = (head: Uint8Array, chunks: ReadonlyArray<Uint8Array>) => {
  const parts = [head, ...chunks]
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

const PLATFORM = os.platform() === "darwin" ? "macos" : os.platform()

export const connect = (connector: Connector, socketPath: string): Effect.Effect<Connection, RexError, Scope.Scope> =>
  Effect.gen(function* () {
    const unreachable = (method: string) => (e: { readonly message: string }) =>
      new RexError({ method, code: "unreachable", message: `${socketPath}: ${e.message}` })

    const socket = yield* connector(socketPath)
    const pull = yield* Socket.readerBytes(socket).pipe(Effect.mapError(unreachable("connect")))
    const writer = yield* socket.writer
    const write = (frame: Uint8Array) => writer.write(frame).pipe(Effect.mapError(unreachable("write")))
    const key = handshakeKey()
    yield* write(new TextEncoder().encode(upgradeRequest(key)))

    const upgraded = Effect.gen(function* () {
      let head: Uint8Array = new Uint8Array(0)

      for (;;) {
        head = concat(head, yield* pull.pipe(Effect.mapError(unreachable("connect"))))
        const upgrade = readUpgrade(head, key)

        if (upgrade.status === "accepted") return upgrade.rest

        if (upgrade.status === "refused")
          return yield* new RexError({
            method: "connect",
            code: "unreachable",
            message: `${socketPath}: ${upgrade.reason}`,
          })
      }
    })

    const rest = yield* upgraded.pipe(
      Effect.timeoutOrElse({
        duration: OPEN_TIMEOUT,
        orElse: () => Effect.fail(unreachable("connect")({ message: "no WebSocket upgrade" })),
      }),
    )

    const pending = new Map<string, Deferred.Deferred<unknown, RexError>>()
    const pushed = yield* Queue.unbounded<Pushed, RexError>()
    const welcome = yield* Deferred.make<number, RexError>()
    const read = messageReader()
    let nextId = 0
    let closed: RexError | undefined
    let welcomed = false

    const route = (text: string) =>
      decodeIncoming(text).pipe(
        Effect.flatMap((m) => {
          if (m.type === "welcome") {
            welcomed = true

            return Deferred.succeed(welcome, m.api_server_revision ?? 0)
          }

          if (m.type === "error" && !welcomed)
            return Deferred.fail(
              welcome,
              new RexError({
                method: "hello",
                code: "incompatible",
                message: `${socketPath}: ${m.error?.message ?? "the server refused the hello"}`,
              }),
            )

          if (m.type === "response" && m.id !== undefined) {
            const waiter = pending.get(m.id)

            if (waiter === undefined) return Effect.void

            return m.error === undefined
              ? Deferred.succeed(waiter, m.payload)
              : Deferred.fail(waiter, new RexError({ method: m.id, code: m.error.code, message: m.error.message }))
          }

          if (m.type === "event" || m.type === "error") return Queue.offer(pushed, { type: m.type, payload: m.payload })

          return Effect.void
        }),
        Effect.ignore,
      )

    const handle = (chunk: Uint8Array) =>
      Effect.forEach(read(chunk), (message) => {
        if (message.opcode === OPCODE.text) return route(new TextDecoder().decode(message.data))

        if (message.opcode === OPCODE.ping) return write(encodeFrame(OPCODE.pong, message.data))

        if (message.opcode === OPCODE.close)
          return Effect.fail(unreachable("read")({ message: "the server closed the connection" }))

        return Effect.void
      })

    const lost = (error: RexError) =>
      Effect.gen(function* () {
        closed = error

        for (const waiter of pending.values()) yield* Deferred.fail(waiter, error)
        yield* Deferred.fail(welcome, error)
        yield* Queue.fail(pushed, error)
      })

    yield* handle(rest).pipe(
      Effect.andThen(
        pull.pipe(
          Effect.mapError(unreachable("read")),
          Effect.flatMap((chunks) => Effect.forEach(chunks, handle)),
          Effect.forever,
        ),
      ),
      Effect.catch(lost),
      Effect.forkScoped,
    )

    yield* write(
      encodeText(
        JSON.stringify({
          type: "hello",
          api_revision: API_REVISION,
          client: { kind: "cli", name: "vibest", version: "0", platform: PLATFORM },
        }),
      ),
    )

    const revision = yield* Deferred.await(welcome).pipe(
      Effect.timeoutOrElse({
        duration: OPEN_TIMEOUT,
        orElse: () => Effect.fail(unreachable("connect")({ message: "no welcome" })),
      }),
    )

    const call = (method: string, payload: Schema.JsonObject) =>
      Effect.suspend(() => {
        const id = `vibest-${++nextId}`

        return request(id, method, payload).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))))
      })

    const request = (id: string, method: string, payload: Schema.JsonObject) =>
      Effect.gen(function* () {
        if (closed !== undefined) return yield* new RexError({ method, code: closed.code, message: closed.message })
        const waiter = yield* Deferred.make<unknown, RexError>()
        pending.set(id, waiter)
        yield* write(encodeText(JSON.stringify({ type: "request", id, method, payload })))

        return yield* Deferred.await(waiter).pipe(
          Effect.mapError((e) => (e.method === id ? new RexError({ method, code: e.code, message: e.message }) : e)),
          Effect.timeoutOrElse({
            duration: CALL_TIMEOUT,
            orElse: () =>
              Effect.fail(unreachable(method)({ message: `no answer within ${Duration.format(CALL_TIMEOUT)}` })),
          }),
        )
      })

    return { revision, call, pushed: Stream.fromQueue(pushed) } satisfies Connection
  })
