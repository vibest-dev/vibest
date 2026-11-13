import type { SubscriptionAccount } from "@vibest/schema/subscription"
import { Effect } from "effect"

import { parseJson, record, runCli, type Spawner } from "./index.ts"

export const cursorAccount = (status: unknown, about?: unknown): SubscriptionAccount => {
  if (record(status)?.isAuthenticated !== true) return { kind: "none" }
  const tier = record(about)?.subscriptionTier
  return typeof tier === "string" ? { kind: "subscription", plan: tier } : { kind: "subscription" }
}

export const cursorSubscription = (spawner: Spawner) => (home: string, problem: string | undefined) =>
  Effect.gen(function* () {
    if (problem) return [{ provider: "", error: problem }]
    const status = parseJson(yield* runCli(spawner, "cursor-agent", ["status", "--format", "json"], home))
    if (status === undefined) return [{ provider: "", error: "cursor-agent status failed" }]
    const account = cursorAccount(
      status,
      parseJson(yield* runCli(spawner, "cursor-agent", ["about", "--format", "json"], home)),
    )
    return [{ provider: "", account, limits: [] }]
  })
