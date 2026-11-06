import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"

import { clampPercent, num, record } from "./index.ts"

export const claudeAccount = (status: unknown): SubscriptionAccount => {
  const s = record(status)
  if (s?.loggedIn !== true) return { kind: "none" }
  if (s.authMethod !== "claude.ai") return { kind: "api-key" }
  return typeof s.subscriptionType === "string"
    ? { kind: "subscription", plan: s.subscriptionType }
    : { kind: "subscription" }
}

const ENDPOINT_WINDOWS: ReadonlyArray<readonly [key: string, window: string]> = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "7d-opus"],
  ["seven_day_sonnet", "7d-sonnet"],
]

export const claudeUsage = (body: unknown): ReadonlyArray<SubscriptionLimit> => {
  const b = record(body)
  if (!b) return []
  return ENDPOINT_WINDOWS.flatMap<SubscriptionLimit>(([key, window]) => {
    const w = record(b[key])
    const used = num(w?.utilization)
    if (!w || used === undefined) return []
    const reset = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN
    const percent = clampPercent(used)
    return [
      {
        window,
        percent,
        status: percent >= 100 ? "limited" : "available",
        resetTime: Number.isNaN(reset) ? null : reset,
      },
    ]
  })
}
