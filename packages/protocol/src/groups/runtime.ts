import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { ProtocolMiddleware } from "../middleware.ts"
import { RuntimeDoctor } from "../schemas.ts"

export const RuntimeGroup = HttpApiGroup.make("server.runtime")
  .add(
    HttpApiEndpoint.post("runtime.doctor", "/api/runtime/doctor", {
      payload: Schema.Struct({ harnesses: Schema.Array(Schema.String) }),
      success: Schema.Array(RuntimeDoctor),
    }).annotateMerge(OpenApi.annotations({ identifier: "runtime.doctor", summary: "Run runtime doctor checks" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "runtime" }))
