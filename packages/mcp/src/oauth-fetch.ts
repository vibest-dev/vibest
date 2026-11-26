import crypto from "node:crypto"

import { parseErrorResponse, type FetchLike } from "@modelcontextprotocol/client"
import { Cause, Effect, Match } from "effect"
import { FetchHttpClient } from "effect/http"

export const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024

const enforceHttpBodyLimit = (response: Response): Response => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""

  if (contentType.includes("text/event-stream")) return response
  const rawLength = response.headers.get("content-length")

  if (rawLength !== null) {
    const parsedLength = Number(rawLength)

    if (Number.isFinite(parsedLength) && parsedLength > MAX_HTTP_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error(`MCP HTTP response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes (${parsedLength} bytes)`)
    }
  }

  if (!response.body) return response
  let totalBytes = 0

  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength

      if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
        controller.error(new Error(`MCP HTTP response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes`))

        return
      }

      controller.enqueue(chunk)
    },
  })

  return new Response(response.body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export const createScopedFetch = (options: {
  readonly serverUrl: string
  readonly customHeaders?: Readonly<Record<string, string>> | undefined
  readonly baseFetch?: FetchLike | undefined
}): FetchLike => {
  const base = options.baseFetch ?? globalThis.fetch
  const allowedOrigin = new URL(options.serverUrl).origin

  return (input, init) => {
    const targetUrl = input instanceof URL ? input : new URL(input)
    const headers = new Headers(init?.headers)

    if (options.customHeaders && targetUrl.origin === allowedOrigin) {
      for (const [key, value] of Object.entries(options.customHeaders)) {
        if (!headers.has(key)) headers.set(key, value)
      }
    }

    return base(input, { ...init, headers, redirect: "manual" })
  }
}

export const loggedFetch = (fields: {
  readonly server: string
  readonly serverUrl: string
  readonly directory?: string | undefined
  readonly customHeaders?: Readonly<Record<string, string>> | undefined
  readonly baseFetch?: FetchLike | undefined
}) =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context())
    const contextFetch = yield* FetchHttpClient.Fetch
    const base: FetchLike = fields.baseFetch ?? ((input, init) => contextFetch(input, init))

    const scoped = createScopedFetch({
      serverUrl: fields.serverUrl,
      customHeaders: fields.customHeaders,
      baseFetch: base,
    })

    const request: FetchLike = (url, init) => {
      const grant = init?.body instanceof URLSearchParams ? init.body.get("grant_type") : undefined

      const operation = Match.value(grant).pipe(
        Match.when("refresh_token", () => "refresh" as const),
        Match.when("authorization_code", () => "exchange" as const),
        Match.orElse(() => undefined),
      )

      const started = Date.now()
      const targetOrigin = url instanceof URL ? url.origin : new URL(url).origin

      return run(
        Effect.gen(function* () {
          if (operation) yield* Effect.logInfo("mcp oauth request started")

          const response = yield* Effect.tryPromise({
            try: async () => enforceHttpBodyLimit(await scoped(url, init)),
            catch: (error) => error,
          })

          const result = { status: response.status, durationMs: Date.now() - started }

          if (operation && !response.ok) {
            const error = yield* Effect.tryPromise(async () => parseErrorResponse(await response.clone().text())).pipe(
              Effect.orElseSucceed(() => undefined),
            )

            yield* Effect.logWarning("mcp oauth request rejected", {
              ...result,
              error: error?.code,
              message: error?.message,
            })
          }

          if (operation && response.ok) {
            yield* Effect.logInfo("mcp oauth request succeeded", result)
          }

          if (!operation && (response.status === 401 || response.status === 403)) {
            yield* Effect.logWarning("mcp http authentication rejected", result)
          }

          return response
        }).pipe(
          Effect.onError((cause) => {
            if (init?.signal?.aborted) return Effect.logDebug("mcp http request aborted")
            const err = Cause.squash(cause)

            return Effect.logWarning("mcp http request failed", {
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - started,
            })
          }),
          Effect.annotateLogs({
            server: fields.server,
            ...(fields.directory !== undefined && { directory: fields.directory }),
            requestID: crypto.randomUUID(),
            origin: targetOrigin,
            method: init?.method ?? "GET",
            ...(operation !== undefined && { operation }),
          }),
        ),
      )
    }

    return request
  })
