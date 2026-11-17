import type { SubscriptionAccount } from "@vibest/schema/subscription"
import { Effect, Predicate, Schema } from "effect"

import { parseJson, record, runCli, type Spawner } from "./index.ts"

export const claudeAccount = (status: Schema.Json | undefined): SubscriptionAccount => {
  const s = record(status)

  if (s?.loggedIn !== true) return { kind: "none" }

  if (s.authMethod !== "claude.ai") return { kind: "api-key" }

  return Predicate.isString(s.subscriptionType)
    ? { kind: "subscription", plan: s.subscriptionType }
    : { kind: "subscription" }
}

export const claudeSubscription = (spawner: Spawner) => (home: string) =>
  Effect.gen(function* () {
    const status = parseJson(yield* runCli(spawner, "claude", ["auth", "status", "--json"], home))

    if (status === undefined) return [{ provider: "", error: "claude auth status failed" }]

    return [{ provider: "", account: claudeAccount(status), limits: [] }]
  })
