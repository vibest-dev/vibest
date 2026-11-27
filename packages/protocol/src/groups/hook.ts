import { HarnessUnavailable, NoSuchSession } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { AdmissionMiddleware, CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

export const HookGroup = HttpApiGroup.make("server.hook")
  .add(
    HttpApiEndpoint.post("hook.ready", "/api/hook/ready", {
      payload: Schema.Struct({
        pid: Schema.optional(Schema.Int),
        conversation: Schema.optional(Schema.Struct({ harness: Schema.String, id: Schema.String })),
      }),
      success: Schema.Struct({ process: Schema.optional(Schema.Number) }),
      error: [Forbidden, NoSuchSession],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "hook.ready", summary: "Report harness session ready" })),
  )
  .add(
    HttpApiEndpoint.post("hook.prompt", "/api/hook/:harness/prompt", {
      params: Schema.Struct({ harness: Schema.String }),
      payload: Schema.String.pipe(HttpApiSchema.asText()),
      success: HttpApiSchema.NoContent,
      error: [Forbidden, HarnessUnavailable],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "hook.prompt", summary: "Report harness prompt hook" })),
  )
  .add(
    HttpApiEndpoint.post("hook.executionEnd", "/api/hook/:harness/execution-end", {
      params: Schema.Struct({ harness: Schema.String }),
      payload: Schema.String.pipe(HttpApiSchema.asText()),
      success: HttpApiSchema.NoContent,
      error: [Forbidden, HarnessUnavailable],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(
        OpenApi.annotations({ identifier: "hook.executionEnd", summary: "Report harness execution-end hook" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("hook.guard", "/api/hook/:harness/guard", {
      params: Schema.Struct({ harness: Schema.String }),
      payload: Schema.String.pipe(HttpApiSchema.asText()),
      success: Schema.Unknown,
      error: [Forbidden, HarnessUnavailable],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "hook.guard", summary: "Check harness tool call guard" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "hook" }))
