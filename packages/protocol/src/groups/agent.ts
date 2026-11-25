import { MachineName } from "@vibest/schema/id"
import { MachineIncompatible, MachineUnavailable, UnknownMachine } from "@vibest/schema/machine"
import { AgentListing } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

export const AgentGroup = HttpApiGroup.make("server.agent")
  .add(
    HttpApiEndpoint.get("agent.list", "/api/agent", {
      query: Schema.Struct({ machine: Schema.optional(MachineName) }),
      success: AgentListing,
      error: [Forbidden, UnknownMachine, MachineUnavailable, MachineIncompatible],
    }).annotateMerge(OpenApi.annotations({ identifier: "agent.list", summary: "List agent definitions" })),
  )
  .add(
    HttpApiEndpoint.get("agent.outdated", "/api/agent/outdated", {
      success: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          agent: Schema.String,
          harness: Schema.String,
          integration: Schema.NullOr(Schema.String),
          working: Schema.Boolean,
          blocked: Schema.NullOr(Schema.String),
        }),
      ),
      error: [Forbidden],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "agent.outdated", summary: "List outdated agents" })),
  )
  .add(
    HttpApiEndpoint.post("agent.restart", "/api/agent/restart", {
      payload: Schema.Struct({
        ids: Schema.Array(Schema.String),
        after: Schema.optional(Schema.Number),
      }),
      success: HttpApiSchema.NoContent,
      error: [Forbidden],
    })
      .middleware(CallerMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "agent.restart", summary: "Restart outdated agents" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "agent" }))
