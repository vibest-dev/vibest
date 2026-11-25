import http from "node:http"
import net from "node:net"

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
  ReqHeadSchema,
  ResHeadSchema,
} from "@vibest/client/pipe-frame"
import { Effect, Option, Predicate, Schema } from "effect"

export class ConnectFailed extends Schema.TaggedError<ConnectFailed>()("ConnectFailed", { message: Schema.String }) {}

export type PipeStdio = { readonly stdin: NodeJS.ReadableStream; readonly stdout: NodeJS.WritableStream }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const decodeReqHead = Schema.decodeUnknownOption(ReqHeadSchema)
const encodeResHead = Schema.encodeSync(ResHeadSchema)

const probeSocket = (socket: string) =>
  Effect.callback<void, ConnectFailed>((resume) => {
    const conn = net.createConnection(socket)
    conn.once("connect", () => {
      conn.destroy()
      resume(Effect.void)
    })
    conn.once("error", (err) => {
      conn.destroy()
      resume(Effect.fail(new ConnectFailed({ message: err.message })))
    })

    return Effect.sync(() => conn.destroy())
  })

export const servePipe = (socket: string, io: PipeStdio = process) =>
  probeSocket(socket).pipe(
    Effect.andThen(
      Effect.callback<void, ConnectFailed>((resume) => {
        const parser = new FrameParser()
        const active = new Map<number, http.ClientRequest>()
        let finished = false

        const finish = (error?: Error) => {
          if (finished) return
          finished = true

          for (const req of active.values()) req.destroy()
          active.clear()
          resume(error === undefined ? Effect.void : Effect.fail(new ConnectFailed({ message: error.message })))
        }

        const writeOut = (bytes: Uint8Array) => {
          if (!finished) io.stdout.write(bytes)
        }

        writeOut(PIPE_MAGIC)

        const onFrame = (type: number, streamId: number, payload: Uint8Array) => {
          if (type === FRAME_PING) {
            writeOut(encodeFrame(FRAME_PONG, 0))

            return
          }

          if (type === FRAME_PONG) return

          if (type === FRAME_REQ_HEAD) {
            const decoded = decodeReqHead(textDecoder.decode(payload))

            if (Option.isNone(decoded)) {
              writeOut(encodeFrame(FRAME_RST, streamId, textEncoder.encode("malformed request head")))

              return
            }

            const headers: Record<string, string> = {}

            for (const [k, v] of decoded.value.headers) headers[k] = v

            const req = http.request(
              {
                socketPath: socket,
                method: decoded.value.method,
                path: decoded.value.path,
                headers,
              },
              (res) => {
                const resHeaders: Array<readonly [string, string]> = []

                for (const [k, v] of Object.entries(res.headers)) {
                  if (v === undefined) continue

                  if (Array.isArray(v)) {
                    for (const item of v) resHeaders.push([k, item])
                  } else {
                    resHeaders.push([k, v])
                  }
                }

                writeOut(
                  encodeFrame(
                    FRAME_RES_HEAD,
                    streamId,
                    textEncoder.encode(encodeResHead({ status: res.statusCode ?? 500, headers: resHeaders })),
                  ),
                )

                res.on("data", (chunk: Buffer | string) => {
                  writeOut(
                    encodeFrame(
                      FRAME_RES_DATA,
                      streamId,
                      Predicate.isString(chunk) ? textEncoder.encode(chunk) : new Uint8Array(chunk),
                    ),
                  )
                })

                res.on("end", () => {
                  active.delete(streamId)
                  writeOut(encodeFrame(FRAME_RES_END, streamId))
                })

                res.on("error", (err) => {
                  active.delete(streamId)
                  writeOut(encodeFrame(FRAME_RST, streamId, textEncoder.encode(err.message)))
                })
              },
            )

            req.on("error", (err) => {
              active.delete(streamId)
              writeOut(encodeFrame(FRAME_RST, streamId, textEncoder.encode(err.message)))
            })

            active.set(streamId, req)

            return
          }

          if (type === FRAME_REQ_DATA) {
            active.get(streamId)?.write(payload)

            return
          }

          if (type === FRAME_REQ_END) {
            active.get(streamId)?.end()

            return
          }

          if (type === FRAME_RST) {
            const req = active.get(streamId)
            active.delete(streamId)
            req?.destroy()
          }
        }

        const onData = (chunk: Buffer | string) => {
          const bytes = Predicate.isString(chunk) ? textEncoder.encode(chunk) : new Uint8Array(chunk)
          const parsed = parser.push(bytes)

          if (parsed.magic === "mismatch") {
            finish(new Error("incompatible peer magic"))

            return
          }

          for (const frame of parsed.frames) onFrame(frame.type, frame.streamId, frame.payload)
        }

        const onEnd = () => finish()
        const onError = (err: Error) => finish(err)

        io.stdin.on("data", onData)
        io.stdin.on("end", onEnd)
        io.stdin.on("close", onEnd)
        io.stdin.on("error", onError)
        io.stdout.on("error", onError)

        return Effect.sync(() => {
          io.stdin.off("data", onData)
          io.stdin.off("end", onEnd)
          io.stdin.off("close", onEnd)
          io.stdin.off("error", onError)
          io.stdout.off("error", onError)
          finish()
        })
      }),
    ),
  )
