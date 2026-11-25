import { Mcp } from "@vibest/core/mcp"
import { VibestApi } from "@vibest/protocol/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

export const McpHandler = HttpApiBuilder.group(VibestApi, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service

    return handlers
      .handle("mcp.list", ({ query }) => mcp.list(query.directory))
      .handle("mcp.add", ({ params, payload }) => mcp.add(params.server, payload))
      .handle("mcp.remove", ({ params }) => mcp.remove(params.server))
      .handle("mcp.connect", ({ params, payload }) => mcp.connect(params.server, payload?.directory))
      .handle("mcp.disconnect", ({ params }) => mcp.disconnect(params.server))
      .handle("mcp.tools", ({ query }) => mcp.tools(query.server, query.directory))
      .handle("mcp.search", ({ query }) => mcp.search(query.q, query.directory))
      .handle("mcp.describe", ({ params, query }) => mcp.describe(params.server, params.tool, query.directory))
      .handle("mcp.call", ({ params, payload }) =>
        mcp.call({
          server: params.server,
          tool: params.tool,
          args: payload.arguments,
          directory: payload.directory,
          maxBytes: payload.maxBytes,
          scratchpadDir: payload.scratchpadDir,
        }),
      )
      .handle("mcp.events", ({ params, query }) => mcp.events(params.server, query.directory))
      .handle("mcp.syncSkills", ({ payload }) => mcp.syncSkills(payload?.projectDir))
      .handle("mcp.authStart", ({ params }) => mcp.authStart(params.server))
      .handle("mcp.authComplete", ({ params, payload }) =>
        mcp.authComplete(params.server, payload.redirectUrlOrCode, payload.state),
      )
      .handle("mcp.authSetToken", ({ params, payload }) => mcp.authSetToken(params.server, payload))
      .handle("mcp.authLogout", ({ params }) => mcp.authLogout(params.server))
  }),
)
