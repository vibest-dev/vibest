// Claude Code. Login: `claude auth status --json`. Usage: the OAuth usage endpoint `/usage` reads
// (GET https://api.anthropic.com/api/oauth/usage). Nothing here reads the `--output-format stream-json`
// stream yet; when something does, its `rate_limit_event` parsing comes back with it.
import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"

import { clampPercent, num, record } from "./index.ts"

/** `claude auth status --json`: `{ loggedIn, authMethod, apiProvider, subscriptionType, … }`. */
export const claudeAccount = (status: unknown): SubscriptionAccount => {
  const s = record(status)
  if (s?.loggedIn !== true) return { kind: "none" }
  // Verified: "claude.ai" with subscriptionType "max". Anything else signed in (API key, apiKeyHelper, Bedrock,
  // Vertex) has no subscription windows: assumed from the field's name, not seen on this machine.
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

/**
 * The OAuth usage endpoint: `{ five_hour: { utilization (0–100), resets_at (ISO) }, seven_day: …, seven_day_opus: null, … }`.
 * A window the account does not have is null and is skipped. A window is limited at 100.
 */
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
