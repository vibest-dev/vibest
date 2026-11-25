import { Subscriptions } from "@vibest/core/subscriptions/service"
import { VibestApi } from "@vibest/protocol/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

export const SubscriptionHandler = HttpApiBuilder.group(VibestApi, "server.subscription", (handlers) =>
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions.Service

    return handlers.handle("subscription.list", () => subscriptions.read)
  }),
)
