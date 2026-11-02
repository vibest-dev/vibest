// Cursor (cursor-agent). Login: `cursor-agent status --format json` and `cursor-agent about --format json`. Usage: the
// Connect RPCs the CLI's own `/usage` command calls, POST https://api2.cursor.sh/aiserver.v1.DashboardService/
// {GetCurrentPeriodUsage, GetHardLimit} with body `{}`, JSON in and out.
import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"
import { clampPercent, num, record } from "./index.ts"

/** `status`: `{ isAuthenticated, … }`; `about`: `{ subscriptionTier, … }` (optional, it only adds the plan). */
export const cursorAccount = (status: unknown, about?: unknown): SubscriptionAccount => {
  if (record(status)?.isAuthenticated !== true) return { kind: "none" }
  const tier = record(about)?.subscriptionTier
  // Assumed: a CURSOR_API_KEY login is not told apart (not seen on this machine); it draws on the same plan.
  return typeof tier === "string" ? { kind: "subscription", plan: tier } : { kind: "subscription" }
}

/**
 * GetCurrentPeriodUsage: `{ billingCycleEnd (epoch ms as a string), planUsage: { totalPercentUsed, autoPercentUsed,
 * apiPercentUsed, includedSpend, limit } }`; GetHardLimit: `{ noUsageBasedAllowed?, hardLimit? }`.
 * One monthly window per bucket the CLI shows (total, Auto models, named API models). A bucket is limited at 100 only
 * when on-demand usage cannot take over (`noUsageBasedAllowed`, or no hard limit known). No `planUsage` (enterprise
 * spend accounts): no windows.
 */
export const cursorUsage = (usage: unknown, hardLimit?: unknown): ReadonlyArray<SubscriptionLimit> => {
  const u = record(usage)
  const plan = record(u?.planUsage)
  if (!u || !plan) return []
  const end = num(u.billingCycleEnd)
  const resetTime = end !== undefined && end > 0 ? end : null
  const h = record(hardLimit)
  const onDemand = h !== undefined && h.noUsageBasedAllowed !== true && (num(h.hardLimit) ?? 0) > 0
  const included = num(plan.limit) ?? 0
  const total = num(plan.totalPercentUsed) ?? (included > 0 ? ((num(plan.includedSpend) ?? 0) / included) * 100 : undefined)
  const buckets: ReadonlyArray<readonly [string, number | undefined]> = [
    ["monthly", total],
    ["monthly-auto", num(plan.autoPercentUsed)],
    ["monthly-api", num(plan.apiPercentUsed)],
  ]
  return buckets.flatMap<SubscriptionLimit>(([window, used]) => {
    if (used === undefined) return []
    const percent = clampPercent(used)
    return [{ window, percent, status: percent >= 100 && !onDemand ? "limited" : "available", resetTime }]
  })
}
