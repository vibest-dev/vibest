import http from "node:http"

import { encodeBody, buildStreamResponse, requestHeadersRecord } from "@vibest/client/unix-http"
import { Cause, Effect, Predicate, Queue, Stream } from "effect"
import { HttpClient, HttpClientError } from "effect/http"

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const textEncoder = new TextEncoder()

export const nodeUnixHttpClient = (socketPath: string): HttpClient.HttpClient =>
  HttpClient.make((request, url, signal) =>
    Effect.flatMap(encodeBody(request), (bodyBytes) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Uint8Array, Cause.Done | HttpClientError.HttpClientError>()

        return yield* Effect.callback<ReturnType<typeof buildStreamResponse>, HttpClientError.HttpClientError>(
          (resume) => {
            const headers = requestHeadersRecord(request)

            if (bodyBytes !== undefined && headers["content-length"] === undefined)
              headers["content-length"] = String(bodyBytes.byteLength)

            const req = http.request(
              {
                socketPath,
                method: request.method,
                path: `${url.pathname}${url.search}`,
                headers,
              },
              (res) => {
                const status = res.statusCode ?? 500
                const rawHeaders: Array<readonly [string, string]> = []

                for (const [key, value] of Object.entries(res.headers)) {
                  if (value === undefined) continue

                  if (Array.isArray(value)) {
                    for (const item of value) rawHeaders.push([key, item])
                  } else {
                    rawHeaders.push([key, value])
                  }
                }

                if (NULL_BODY_STATUSES.has(status)) {
                  res.resume()
                  Queue.endUnsafe(queue)
                  resume(Effect.succeed(buildStreamResponse(request, status, rawHeaders, Stream.empty)))

                  return
                }

                res.on("data", (chunk: Buffer | string) => {
                  Queue.offerUnsafe(
                    queue,
                    Predicate.isString(chunk) ? textEncoder.encode(chunk) : new Uint8Array(chunk),
                  )
                })

                res.on("end", () => {
                  Queue.endUnsafe(queue)
                })

                res.on("close", () => {
                  if (res.complete) Queue.endUnsafe(queue)
                  else
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(
                        new HttpClientError.HttpClientError({
                          reason: new HttpClientError.TransportError({
                            request,
                            cause: new Error("connection closed"),
                          }),
                        }),
                      ),
                    )
                })

                res.on("error", (cause) => {
                  Queue.failCauseUnsafe(
                    queue,
                    Cause.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request, cause }),
                      }),
                    ),
                  )
                })

                const bodyStream = Stream.fromQueue(queue).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      req.destroy()
                      res.destroy()
                    }),
                  ),
                )

                resume(Effect.succeed(buildStreamResponse(request, status, rawHeaders, bodyStream)))
              },
            )

            const onAbort = () => {
              req.destroy()
            }

            if (signal.aborted) {
              req.destroy()
            } else {
              signal.addEventListener("abort", onAbort, { once: true })
            }

            req.on("error", (cause) => {
              signal.removeEventListener("abort", onAbort)

              const err = new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              })

              Queue.failCauseUnsafe(queue, Cause.fail(err))
              resume(Effect.fail(err))
            })

            req.on("close", () => {
              signal.removeEventListener("abort", onAbort)
            })

            if (bodyBytes !== undefined) req.write(bodyBytes)
            req.end()

            return Effect.sync(() => {
              signal.removeEventListener("abort", onAbort)
              req.destroy()
            })
          },
        )
      }),
    ),
  )
