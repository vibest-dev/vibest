import { NoSuchSession } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import { BooleanFromQuery, NonNegativeIntFromQuery, StoredEvent } from "../schemas.ts"

export const EventGroup = HttpApiGroup.make("server.event")
  .add(
    HttpApiEndpoint.get("event.subscribe", "/api/event", {
      query: Schema.Struct({
        session: Schema.optional(Schema.String),
        after: Schema.optional(NonNegativeIntFromQuery),
        follow: Schema.optional(BooleanFromQuery),
      }),
      success: HttpApiSchema.StreamSse({ data: StoredEvent, keepAlive: "15 seconds" }),
      error: [Forbidden, NoSuchSession],
    }).annotateMerge(OpenApi.annotations({ identifier: "event.subscribe", summary: "Subscribe to event log" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "event" }))
