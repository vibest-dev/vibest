import { CodeMode } from "@vibest/schema/codemode"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

export const CodeModeGroup = HttpApiGroup.make("server.codemode")
  .add(
    HttpApiEndpoint.post("codemode.execute", "/api/codemode/execute", {
      payload: CodeMode.ExecuteRequest,
      success: CodeMode.ExecutionResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "codemode.execute",
        summary: "Execute JavaScript in the confined Psychoscript CodeMode sandbox with mounted MCP tools",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("codemode.declarations", "/api/codemode/declarations", {
      query: {
        directory: Schema.optional(Schema.String),
        server: Schema.optional(Schema.String),
      },
      success: CodeMode.DeclarationsResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "codemode.declarations",
        summary: "Render TypeScript declarations for MCP tools available in CodeMode",
      }),
    ),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "codemode" }))
