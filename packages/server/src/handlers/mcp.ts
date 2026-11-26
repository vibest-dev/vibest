import { Mcp } from "@vibest/core/mcp"
import { ToolOutput } from "@vibest/core/tool-output"
import { VibestApi } from "@vibest/protocol/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import * as CallerChecks from "./caller.ts"

export const McpHandler = HttpApiBuilder.group(VibestApi, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const toolOutput = yield* ToolOutput.Service
    const checks = yield* CallerChecks.Service

    return handlers
      .handle("mcp.list", ({ query }) => mcp.list(query.directory))
      .handle("mcp.add", ({ params, payload }) =>
        checks.cliOnly("mcp.add").pipe(Effect.andThen(mcp.add(params.server, payload))),
      )
      .handle("mcp.remove", ({ params }) =>
        checks.cliOnly("mcp.remove").pipe(Effect.andThen(mcp.remove(params.server))),
      )
      .handle("mcp.connect", ({ params, payload }) => mcp.connect(params.server, payload?.directory))
      .handle("mcp.disconnect", ({ params }) => mcp.disconnect(params.server))
      .handle("mcp.tools", ({ query }) => mcp.tools(query.server, query.directory))
      .handle("mcp.search", ({ query }) => mcp.search(query.q, query.directory))
      .handle("mcp.describe", ({ params, query }) => mcp.describe(params.server, params.tool, query.directory))
      .handle("mcp.call", ({ params, payload }) =>
        mcp
          .call({
            server: params.server,
            tool: params.tool,
            args: payload.arguments,
            directory: payload.directory,
          })
          .pipe(
            Effect.flatMap((result) =>
              toolOutput.truncateCallResult({
                server: params.server,
                tool: params.tool,
                result,
                maxBytes: payload.maxBytes,
                scratchpadDir: payload.scratchpadDir,
              }),
            ),
          ),
      )
      .handle("mcp.events", ({ params, query }) => mcp.events(params.server, query.directory))
      .handle("mcp.skills", ({ params, query }) => mcp.skills(params.server, query.directory))
      .handle("mcp.read", ({ params, payload }) =>
        mcp
          .read({
            server: params.server,
            uri: payload.uri,
            directory: payload.directory,
          })
          .pipe(
            Effect.flatMap((result) =>
              toolOutput.truncateResourceResult({
                server: params.server,
                uri: payload.uri,
                result,
                maxBytes: payload.maxBytes,
                scratchpadDir: payload.scratchpadDir,
              }),
            ),
          ),
      )
      .handle("mcp.authStart", ({ params }) =>
        checks.cliOnly("mcp.authStart").pipe(Effect.andThen(mcp.authStart(params.server))),
      )
      .handle("mcp.authComplete", ({ params, payload }) =>
        checks
          .cliOnly("mcp.authComplete")
          .pipe(Effect.andThen(mcp.authComplete(params.server, payload.redirectUrlOrCode, payload.state))),
      )
      .handle("mcp.authSetToken", ({ params, payload }) =>
        checks.cliOnly("mcp.authSetToken").pipe(Effect.andThen(mcp.authSetToken(params.server, payload))),
      )
      .handle("mcp.authLogout", ({ params }) =>
        checks.cliOnly("mcp.authLogout").pipe(Effect.andThen(mcp.authLogout(params.server))),
      )
  }),
)
