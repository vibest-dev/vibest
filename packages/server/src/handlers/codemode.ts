import { CodeMode } from "@vibest/core/codemode"
import { ToolOutput } from "@vibest/core/tool-output"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
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

import { VIBEST_NAMESPACE } from "../codemode/vibest-api-tools.ts"
import * as CallerChecks from "./caller.ts"

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
    const checks = yield* CallerChecks.Service

    return handlers
      .handle("codemode.execute", ({ payload }) =>
        Effect.gen(function* () {
          const scope = yield* checks.mcpScope

          if (Option.isSome(scope) && payload.servers !== undefined) {
            for (const server of payload.servers) {
              if (server !== VIBEST_NAMESPACE && !scope.value.allowed.has(server)) {
                return yield* new Forbidden({
                  method: "codemode.execute",
                  message: `agent "${scope.value.agent}" does not allow MCP server "${server}"`,
                })
              }
            }
          }

          const request = yield* HttpServerRequest.HttpServerRequest
          const headers = extractCallerHeaders(request.headers)
          const allowedExternalServers = Option.isSome(scope) ? [...scope.value.allowed] : undefined

          const result = yield* codemode.execute(payload, {
            ...(headers !== undefined && { headers }),
            ...(allowedExternalServers !== undefined && { allowedExternalServers }),
          })

          return yield* toolOutput.truncateExecutionResult(result)
        }),
      )
      .handle("codemode.declarations", ({ query }) =>
        Effect.gen(function* () {
          if (query.server !== undefined && query.server !== VIBEST_NAMESPACE) {
            yield* checks.requireMcpServer("codemode.declarations", query.server)
          }

          const scope = yield* checks.mcpScope
          const allowedExternalServers = Option.isSome(scope) ? [...scope.value.allowed] : undefined

          return yield* codemode.declarations({
            directory: query.directory,
            ...(query.server !== undefined && { servers: [query.server] }),
            ...(allowedExternalServers !== undefined && { allowedExternalServers }),
          })
        }),
      )
  }),
)
