import { MachineName } from "@vibest/schema/id"
import { MachineIncompatible, MachineUnavailable, UnknownMachine } from "@vibest/schema/machine"
import { HarnessChoice } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { ProtocolMiddleware } from "../middleware.ts"

export const HarnessGroup = HttpApiGroup.make("server.harness")
  .add(
    HttpApiEndpoint.get("harness.list", "/api/harness", {
      query: Schema.Struct({
        provider: Schema.optional(Schema.String),
        machine: Schema.optional(MachineName),
      }),
      success: Schema.Array(HarnessChoice),
      error: [Forbidden, UnknownMachine, MachineUnavailable, MachineIncompatible],
    }).annotateMerge(OpenApi.annotations({ identifier: "harness.list", summary: "List harnesses" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "harness" }))
