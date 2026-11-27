import { VibestApi } from "@vibest/protocol/api"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Option, Predicate, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientError, type HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import * as Socket from "effect/socket/Socket"

import {
  encodeFrame,
  FRAME_PING,
  FRAME_PONG,
  FRAME_REQ_DATA,
  FRAME_REQ_END,
  FRAME_REQ_HEAD,
  FRAME_RES_DATA,
  FRAME_RES_END,
  FRAME_RES_HEAD,
  FRAME_RST,
  FrameParser,
  PIPE_MAGIC,
  PipeIncompatible,
  ReqHeadSchema,
  ResHeadSchema,
} from "./pipe-frame.ts"
import { applyRequestHeaders, buildStreamResponse, encodeBody, requestHeadersRecord } from "./unix-http.ts"

export { PipeIncompatible } from "./pipe-frame.ts"

declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

const HANDSHAKE_TIMEOUT = Duration.seconds(5)
const PING_INTERVAL = Duration.seconds(5)
const PING_TIMEOUT = Duration.seconds(10)

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const encodeReqHead = Schema.encodeSync(ReqHeadSchema)
const decodeResHead = Schema.decodeUnknownOption(ResHeadSchema)

export const stdioSocket = (streams: Socket.InputTransformStream) => Socket.fromTransformStream(Effect.succeed(streams))

interface PendingStream {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly head: Deferred.Deferred<
    { readonly status: number; readonly headers: ReadonlyArray<readonly [string, string]> },
    Error
  >
  readonly queue: Queue.Queue<Uint8Array, Cause.Done | HttpClientError.HttpClientError>
}

export const pipeHttpClient = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const handshake = yield* Deferred.make<void, PipeIncompatible | Error>()
    const streams = new Map<number, PendingStream>()
    let nextStreamId = 1
    let closedError: Error | undefined
    let lastActivity = yield* Clock.currentTimeMillis
    const parser = new FrameParser()

    const write = (bytes: Uint8Array) =>
      closedError !== undefined ? Effect.void : writer.write(bytes).pipe(Effect.ignore)

    const transportError = (request: HttpClientRequest.HttpClientRequest, cause: Error) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      })

    const failAll = (err: Error) => {
      if (closedError === undefined) closedError = err
      Deferred.doneUnsafe(handshake, Exit.fail(err))

      for (const [id, entry] of streams) {
        streams.delete(id)
        Deferred.doneUnsafe(entry.head, Exit.fail(err))
        Queue.failCauseUnsafe(entry.queue, Cause.fail(transportError(entry.request, err)))
      }
    }

    yield* Effect.addFinalizer(() => Effect.sync(() => failAll(new Error("pipe closed"))))

    const handleFrame = (type: number, streamId: number, payload: Uint8Array, now: number) => {
      lastActivity = now

      if (type === FRAME_PING) return write(encodeFrame(FRAME_PONG, 0))

      if (type === FRAME_PONG) return Effect.void

      const entry = streams.get(streamId)

      if (entry === undefined) return Effect.void

      if (type === FRAME_RES_HEAD) {
        const decoded = decodeResHead(textDecoder.decode(payload))

        if (Option.isNone(decoded)) {
          streams.delete(streamId)
          const err = new Error("malformed response head")
          Deferred.doneUnsafe(entry.head, Exit.fail(err))
          Queue.failCauseUnsafe(entry.queue, Cause.fail(transportError(entry.request, err)))

          return Effect.void
        }

        Deferred.doneUnsafe(entry.head, Exit.succeed(decoded.value))

        return Effect.void
      }

      if (type === FRAME_RES_DATA) {
        Queue.offerUnsafe(entry.queue, payload)

        return Effect.void
      }

      if (type === FRAME_RES_END) {
        streams.delete(streamId)
        Queue.endUnsafe(entry.queue)

        return Effect.void
      }

      if (type === FRAME_RST) {
        streams.delete(streamId)
        const msg = payload.byteLength > 0 ? textDecoder.decode(payload) : "remote stream reset"
        const err = new Error(msg)
        Deferred.doneUnsafe(entry.head, Exit.fail(err))
        Queue.failCauseUnsafe(entry.queue, Cause.fail(transportError(entry.request, err)))
      }

      return Effect.void
    }

    yield* writer.write(PIPE_MAGIC).pipe(
      Effect.mapError((cause) => new Error(cause.message)),
      Effect.catch((err) => Effect.sync(() => failAll(err))),
    )

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const pulled = yield* reader.pull.pipe(Effect.exit)

          if (Exit.isFailure(pulled)) {
            const err = Cause.isDone(pulled.cause) ? new Error("pipe closed") : new Error(Cause.pretty(pulled.cause))
            Deferred.doneUnsafe(
              handshake,
              Exit.fail(new PipeIncompatible({ message: `pipe closed before handshake: ${err.message}` })),
            )
            failAll(err)

            return
          }

          for (const chunk of pulled.value) {
            const bytes = Predicate.isString(chunk) ? textEncoder.encode(chunk) : chunk
            const parsed = parser.push(bytes)

            if (parsed.magic === "mismatch") {
              const err = new PipeIncompatible({ message: "peer does not speak vibest HTTP pipe protocol" })
              Deferred.doneUnsafe(handshake, Exit.fail(err))
              failAll(new Error(err.message))

              return
            }

            if (parsed.magic === "ok") {
              lastActivity = yield* Clock.currentTimeMillis
              Deferred.doneUnsafe(handshake, Exit.void)
            }

            const now = yield* Clock.currentTimeMillis

            for (const frame of parsed.frames) {
              yield* handleFrame(frame.type, frame.streamId, frame.payload, now)
            }
          }
        }
      }),
    )

    yield* Deferred.await(handshake).pipe(
      Effect.timeoutOrElse({
        duration: HANDSHAKE_TIMEOUT,
        orElse: () => Effect.fail(new PipeIncompatible({ message: "peer did not answer HTTP pipe handshake in time" })),
      }),
    )

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(PING_INTERVAL)

          if (closedError !== undefined) return

          const now = yield* Clock.currentTimeMillis

          if (now - lastActivity >= Duration.toMillis(PING_INTERVAL) + Duration.toMillis(PING_TIMEOUT)) {
            failAll(new Error("stopped answering"))

            return
          }

          yield* write(encodeFrame(FRAME_PING, 0))
        }
      }),
    )

    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        if (closedError !== undefined) return yield* transportError(request, closedError)

        const bodyBytes = yield* encodeBody(request)
        const streamId = nextStreamId++

        const headDeferred = yield* Deferred.make<
          { readonly status: number; readonly headers: ReadonlyArray<readonly [string, string]> },
          Error
        >()

        const queue = yield* Queue.unbounded<Uint8Array, Cause.Done | HttpClientError.HttpClientError>()

        streams.set(streamId, { request, head: headDeferred, queue })

        const headers = Object.entries(requestHeadersRecord(request)).map(([k, v]): readonly [string, string] => [k, v])

        const headPayload = textEncoder.encode(
          encodeReqHead({
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
          }),
        )

        yield* write(encodeFrame(FRAME_REQ_HEAD, streamId, headPayload))

        if (bodyBytes !== undefined && bodyBytes.byteLength > 0)
          yield* write(encodeFrame(FRAME_REQ_DATA, streamId, bodyBytes))

        yield* write(encodeFrame(FRAME_REQ_END, streamId))

        const resHead = yield* Deferred.await(headDeferred).pipe(
          Effect.onInterrupt(() => {
            streams.delete(streamId)
            Queue.endUnsafe(queue)

            return write(encodeFrame(FRAME_RST, streamId))
          }),
          Effect.mapError((cause) => transportError(request, cause)),
        )

        const bodyStream = Stream.fromQueue(queue).pipe(
          Stream.ensuring(
            Effect.suspend(() =>
              streams.delete(streamId) && closedError === undefined
                ? write(encodeFrame(FRAME_RST, streamId))
                : Effect.void,
            ),
          ),
        )

        return buildStreamResponse(request, resHead.status, resHead.headers, bodyStream)
      }),
    )

    return applyRequestHeaders(client)
  })

export const connectPipe = (socket: Socket.Socket) =>
  pipeHttpClient(socket).pipe(
    Effect.flatMap((httpClient) => HttpApiClient.makeWith(VibestApi, { httpClient, baseUrl: "http://vibest" })),
  )

export type PipeClient = Effect.Success<ReturnType<typeof connectPipe>>
