import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"
import { Clock, Effect } from "effect"
import { HttpClientRequest } from "effect/http"

import { CLAUDE_CREDENTIALS, password } from "../keychain.ts"
import { authed, clampPercent, endpoint, num, parseJson, record, runCli, usageOf } from "./index.ts"

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

const epochMs = (value: number) => (value < 1e12 ? value * 1000 : value)

export const claudeToken = (
  raw: string | undefined,
  now: number,
): { readonly token: string } | { readonly error: string } => {
  if (!raw) return { error: "token unreadable" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: "token unreadable" }
  }
  const oauth = record(record(parsed)?.claudeAiOauth)
  const token = oauth?.accessToken
  if (typeof token !== "string" || token === "") return { error: "token unreadable" }
  const exp = num(oauth?.expiresAt)
  if (exp !== undefined && epochMs(exp) <= now) return { error: "token expired" }
  return { token }
}

export const claudeSubscription = (home: string) =>
  Effect.gen(function* () {
    const status = parseJson(yield* runCli("claude", ["auth", "status", "--json"], home))
    if (status === undefined) return [{ provider: "", error: "claude auth status failed" }]
    const account = claudeAccount(status)
    if (account.kind !== "subscription") return [{ provider: "", account, limits: [] }]
    const read = claudeToken(yield* password(CLAUDE_CREDENTIALS, home), yield* Clock.currentTimeMillis)
    if ("error" in read) return [{ provider: "", account, error: read.error }]
    const result = yield* endpoint(
      authed(
        HttpClientRequest.setHeader(
          HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage"),
          "anthropic-beta",
          "oauth-2025-04-20",
        ),
        read.token,
      ),
    )
    return [{ provider: "", account, ...usageOf(result, claudeUsage) }]
  })
