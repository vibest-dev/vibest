import { type AgentMcpScope, mcpDisallowedMessage } from "@vibest/core/agent/mcp-scope"
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

const assertAllowedServers = (
  scope: Option.Option<AgentMcpScope>,
  method: string,
  servers: ReadonlyArray<string> | undefined,
): Effect.Effect<void, Forbidden> => {
  if (Option.isNone(scope) || servers === undefined) return Effect.void

  for (const server of servers) {
    if (server !== VIBEST_NAMESPACE && !scope.value.allowed.has(server)) {
      return Effect.fail(new Forbidden({ method, message: mcpDisallowedMessage(scope.value.agent, server) }))
    }
  }

  return Effect.void
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
          yield* assertAllowedServers(scope, "codemode.execute", payload.servers)

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
          const scope = yield* checks.mcpScope
          const servers = query.server !== undefined ? [query.server] : undefined
          yield* assertAllowedServers(scope, "codemode.declarations", servers)

          const allowedExternalServers = Option.isSome(scope) ? [...scope.value.allowed] : undefined

          return yield* codemode.declarations({
            directory: query.directory,
            ...(servers !== undefined && { servers }),
            ...(allowedExternalServers !== undefined && { allowedExternalServers }),
          })
        }),
      )
  }),
)
