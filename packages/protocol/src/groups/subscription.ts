import { Subscription } from "@vibest/schema/subscription"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

import { ProtocolMiddleware } from "../middleware.ts"

export const SubscriptionGroup = HttpApiGroup.make("server.subscription")
  .add(
    HttpApiEndpoint.get("subscription.list", "/api/subscription", {
      success: Schema.Array(Subscription),
    }).annotateMerge(OpenApi.annotations({ identifier: "subscription.list", summary: "List harness subscriptions" })),
  )
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "subscription" }))
