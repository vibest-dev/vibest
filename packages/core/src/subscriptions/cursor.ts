import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"

import { clampPercent, num, record } from "./index.ts"

export const cursorAccount = (status: unknown, about?: unknown): SubscriptionAccount => {
  if (record(status)?.isAuthenticated !== true) return { kind: "none" }
  const tier = record(about)?.subscriptionTier
  return typeof tier === "string" ? { kind: "subscription", plan: tier } : { kind: "subscription" }
}

export const cursorUsage = (usage: unknown, hardLimit?: unknown): ReadonlyArray<SubscriptionLimit> => {
  const u = record(usage)
  const plan = record(u?.planUsage)
  if (!u || !plan) return []
  const end = num(u.billingCycleEnd)
  const resetTime = end !== undefined && end > 0 ? end : null
  const h = record(hardLimit)
  const onDemandKnown = h !== undefined
  const onDemand = onDemandKnown && h.noUsageBasedAllowed !== true && (num(h.hardLimit) ?? 0) > 0
  const included = num(plan.limit) ?? 0
  const total =
    num(plan.totalPercentUsed) ?? (included > 0 ? ((num(plan.includedSpend) ?? 0) / included) * 100 : undefined)
  const buckets: ReadonlyArray<readonly [string, number | undefined]> = [
    ["monthly", total],
    ["monthly-auto", num(plan.autoPercentUsed)],
    ["monthly-api", num(plan.apiPercentUsed)],
  ]
  return buckets.flatMap<SubscriptionLimit>(([window, used]) => {
    if (used === undefined) return []
    const percent = clampPercent(used)
    const counts = window === "monthly" && percent >= 100 && onDemandKnown && !onDemand
    return [{ window, percent, status: counts ? "limited" : "available", resetTime }]
  })
}
