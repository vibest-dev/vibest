import { Taken } from "@vibest/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden } from "../errors.ts"
import { CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"

export const InboxGroup = HttpApiGroup.make("server.inbox")
  .add(
    HttpApiEndpoint.post("inbox.take", "/api/inbox/take", {
      success: [Taken, HttpApiSchema.NoContent],
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "inbox.take", summary: "Take next inbox batch" })),
  )
  .add(
    HttpApiEndpoint.get("inbox.subscribe", "/api/inbox/subscribe", {
      success: HttpApiSchema.StreamSse({ data: Schema.Null, keepAlive: "15 seconds" }),
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "inbox.subscribe", summary: "Subscribe to inbox wakeups" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "inbox" }))
