import { Mcp } from "@vibest/schema/mcp"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

const ServerPath = { server: Schema.String }
const ServerToolPath = { server: Schema.String, tool: Schema.String }

export const McpGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.list", "/api/mcp", {
      query: { directory: Schema.optional(Schema.String) },
      success: Schema.Array(Mcp.ServerInfo),
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.list", summary: "List configured MCP servers" })),
  )
  .add(
    HttpApiEndpoint.put("mcp.add", "/api/mcp/:server", {
      params: ServerPath,
      payload: Mcp.ServerConfig,
      success: Mcp.ServerInfo,
      error: [Forbidden, Mcp.ConfigError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.add", summary: "Add or update an MCP server" })),
  )
  .add(
    HttpApiEndpoint.delete("mcp.remove", "/api/mcp/:server", {
      params: ServerPath,
      success: Schema.Void,
      error: [Forbidden, Mcp.NotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.remove", summary: "Remove an MCP server" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:server/connect", {
      params: ServerPath,
      payload: Schema.optional(Schema.Struct({ directory: Schema.optional(Schema.String) })),
      success: Mcp.ServerInfo,
      error: [Mcp.NotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.connect", summary: "Connect an MCP server" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:server/disconnect", {
      params: ServerPath,
      success: Schema.Void,
      error: [Mcp.NotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.disconnect", summary: "Disconnect an MCP server" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.tools", "/api/mcp/tools", {
      query: {
        server: Schema.optional(Schema.String),
        directory: Schema.optional(Schema.String),
      },
      success: Schema.Array(Mcp.ToolInfo),
      error: [Mcp.NotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.tools", summary: "List MCP tools" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.search", "/api/mcp/search", {
      query: {
        q: Schema.String,
        directory: Schema.optional(Schema.String),
      },
      success: Schema.Array(Mcp.ToolInfo),
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.search", summary: "Search MCP tools" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.describe", "/api/mcp/:server/tools/:tool", {
      params: ServerToolPath,
      query: { directory: Schema.optional(Schema.String) },
      success: Mcp.ToolInfo,
      error: [Mcp.NotFoundError, Mcp.ToolNotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.describe", summary: "Describe an MCP tool" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.call", "/api/mcp/:server/tools/:tool/call", {
      params: ServerToolPath,
      payload: Schema.Struct({
        arguments: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
        directory: Schema.optional(Schema.String),
        maxBytes: Schema.optional(Schema.Number),
        scratchpadDir: Schema.optional(Schema.String),
      }),
      success: Mcp.CallResult,
      error: [Mcp.NotFoundError, Mcp.ToolCallError, Mcp.AuthError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.call", summary: "Call an MCP tool" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.events", "/api/mcp/:server/events", {
      params: ServerPath,
      query: { directory: Schema.optional(Schema.String) },
      success: Schema.Array(Mcp.EventType),
      error: [Mcp.NotFoundError, Mcp.ToolCallError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.events", summary: "List MCP server event types" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.skills", "/api/mcp/:server/skills", {
      params: ServerPath,
      query: { directory: Schema.optional(Schema.String) },
      success: Schema.Array(Mcp.SkillEntry),
      error: [Mcp.NotFoundError, Mcp.ToolCallError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "mcp.skills", summary: "List SEP-2640 skills advertised by an MCP server" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("mcp.read", "/api/mcp/:server/resources/read", {
      params: ServerPath,
      payload: Schema.Struct({
        uri: Schema.String,
        directory: Schema.optional(Schema.String),
        maxBytes: Schema.optional(Schema.Number),
        scratchpadDir: Schema.optional(Schema.String),
      }),
      success: Mcp.ReadResourceResult,
      error: [Mcp.NotFoundError, Mcp.ToolCallError, Mcp.AuthError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "mcp.read", summary: "Read a skill:// or MCP resource URI with digest check" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("mcp.authStart", "/api/mcp/:server/auth/start", {
      params: ServerPath,
      success: Mcp.AuthStartResult,
      error: [Forbidden, Mcp.NotFoundError, Mcp.AuthError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.authStart", summary: "Start MCP OAuth flow" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.authComplete", "/api/mcp/:server/auth/complete", {
      params: ServerPath,
      payload: Schema.Struct({
        redirectUrlOrCode: Schema.String,
        state: Schema.optional(Schema.String),
      }),
      success: Mcp.AuthCompleteResult,
      error: [Forbidden, Mcp.NotFoundError, Mcp.AuthError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.authComplete", summary: "Complete MCP OAuth flow" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.authSetToken", "/api/mcp/:server/auth/token", {
      params: ServerPath,
      payload: Schema.Struct({
        accessToken: Schema.String,
        refreshToken: Schema.optional(Schema.String),
        expiresAt: Schema.optional(Schema.Number),
        scope: Schema.optional(Schema.String),
      }),
      success: Mcp.AuthCompleteResult,
      error: [Forbidden, Mcp.NotFoundError, Mcp.AuthError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.authSetToken", summary: "Set static MCP token" })),
  )
  .add(
    HttpApiEndpoint.delete("mcp.authLogout", "/api/mcp/:server/auth", {
      params: ServerPath,
      success: Schema.Void,
      error: [Forbidden, Mcp.NotFoundError, Mcp.AuthError],
    }).annotateMerge(OpenApi.annotations({ identifier: "mcp.authLogout", summary: "Remove MCP OAuth credentials" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "mcp" }))
