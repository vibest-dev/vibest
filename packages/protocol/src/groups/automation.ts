import { Automation } from "@vibest/schema/automation"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

const idParam = { id: Schema.String }

export const AutomationGroup = HttpApiGroup.make("server.automation")
  .add(
    HttpApiEndpoint.post("automation.create", "/api/automation", {
      payload: Automation.CreateInput,
      success: Automation.Info,
      error: [Forbidden, Automation.InvalidError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.create",
          summary: "Create a scheduled or MCP event automation",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("automation.list", "/api/automation", {
      query: {
        projectId: Schema.optional(Schema.String),
        sessionId: Schema.optional(Schema.String),
        status: Schema.optional(Automation.Status),
      },
      success: Schema.Array(Automation.Info),
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.list",
          summary: "List automations",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("automation.get", "/api/automation/:id", {
      params: idParam,
      success: Automation.Info,
      error: [Automation.NotFoundError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.get",
          summary: "Get one automation by id",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("automation.pause", "/api/automation/:id/pause", {
      params: idParam,
      success: Automation.Info,
      error: [Automation.NotFoundError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.pause",
          summary: "Pause an automation",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("automation.resume", "/api/automation/:id/resume", {
      params: idParam,
      success: Automation.Info,
      error: [Automation.NotFoundError, Automation.InvalidError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.resume",
          summary: "Resume a paused automation",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("automation.remove", "/api/automation/:id", {
      params: idParam,
      success: Schema.Void,
      error: [Automation.NotFoundError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.remove",
          summary: "Remove an automation",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("automation.tick", "/api/automation/tick", {
      success: Schema.Void,
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.tick",
          summary: "Trigger all due automations immediately",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("automation.runNow", "/api/automation/:id/run-now", {
      params: idParam,
      success: Automation.Info,
      error: [Automation.NotFoundError, Automation.InvalidError],
    })
      .middleware(CallerMiddleware)
      .middleware(ProtocolMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "automation.runNow",
          summary: "Run an automation once immediately",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "automation" }))
