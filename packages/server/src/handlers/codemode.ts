import { CodeMode } from "@vibest/core/codemode"
import { ToolOutput } from "@vibest/core/tool-output"
import { VibestApi } from "@vibest/protocol/api"
import {
  CALLER_HEADER,
  CWD_HEADER,
  PROJECT_HEADER,
  PROTOCOL_HEADER,
  REPOSITORY_HEADER,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import { Effect, Option } from "effect"
import { Headers, HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

const FORWARDED_CALLER_HEADERS = [
  PROTOCOL_HEADER,
  CALLER_HEADER,
  SESSION_HEADER,
  PROJECT_HEADER,
  REPOSITORY_HEADER,
  CWD_HEADER,
] as const

const extractCallerHeaders = (headers: Headers.Headers): Record<string, string> | undefined => {
  const out: Record<string, string> = {}

  for (const name of FORWARDED_CALLER_HEADERS) {
    const value = Option.getOrUndefined(Headers.get(headers, name))

    if (value !== undefined) out[name] = value
  }

  return CALLER_HEADER in out ? out : undefined
}

export const CodeModeHandler = HttpApiBuilder.group(VibestApi, "server.codemode", (handlers) =>
  Effect.gen(function* () {
    const codemode = yield* CodeMode.Service
    const toolOutput = yield* ToolOutput.Service

    return handlers
      .handle("codemode.execute", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const headers = extractCallerHeaders(request.headers)
          const result = yield* codemode.execute(payload, headers !== undefined ? { headers } : undefined)

          return yield* toolOutput.truncateExecutionResult(result)
        }),
      )
      .handle("codemode.declarations", ({ query }) =>
        codemode.declarations({
          directory: query.directory,
          ...(query.server !== undefined && { servers: [query.server] }),
        }),
      )
  }),
)
