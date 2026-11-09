import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"
import { Effect, Option } from "effect"
import { HttpClientRequest } from "effect/http"

import { CURSOR_ACCESS_TOKEN, password } from "../keychain.ts"
import { authed, clampPercent, endpoint, num, parseJson, record, runCli, usageOf } from "./index.ts"

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

export const cursorToken = (raw: string | undefined): { readonly token: string } | { readonly error: string } => {
  const token = raw?.trim()
  return token ? { token } : { error: "token unreadable" }
}

export const cursorSubscription = (home: string, problem: string | undefined) =>
  Effect.gen(function* () {
    if (problem) return [{ provider: "", error: problem }]
    const status = parseJson(yield* runCli("cursor-agent", ["status", "--format", "json"], home))
    if (status === undefined) return [{ provider: "", error: "cursor-agent status failed" }]
    const account = cursorAccount(status, parseJson(yield* runCli("cursor-agent", ["about", "--format", "json"], home)))
    if (account.kind === "none") return [{ provider: "", account, limits: [] }]
    const read = cursorToken(yield* password(CURSOR_ACCESS_TOKEN, home))
    if ("error" in read) return [{ provider: "", account, error: read.error }]
    const hard = yield* endpoint(
      authed(
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"),
          {},
        ),
        read.token,
      ),
    )
    const hardBody = Option.match(hard, {
      onNone: () => undefined,
      onSome: (r) => (r.status === 200 ? r.body : undefined),
    })
    const hardError = Option.match(hard, {
      onNone: () => "GetHardLimit failed",
      onSome: (r) => (r.status === 200 ? undefined : `GetHardLimit answered ${r.status}`),
    })
    const usage = yield* endpoint(
      authed(
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"),
          {},
        ),
        read.token,
      ),
    )
    return [{ provider: "", account, ...usageOf(usage, (body) => cursorUsage(body, hardBody), hardError) }]
  })
