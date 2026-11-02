// Pi. One login per provider. The adapter reports only login readiness (`pi auth check --provider <p> --json
// --no-refresh`) and does not parse provider response headers. A plugin may report the Subscription's limits.
import type { SubscriptionAccount } from "@vibest/schema/subscription"
import { record } from "./index.ts"

/** `pi auth check --json`: `{ status: "ready" | "not_ready", provider, authType?, reason? }`. */
export const piAccount = (check: unknown): SubscriptionAccount => {
  const c = record(check)
  const provider = typeof c?.provider === "string" ? c.provider : undefined
  const withProvider = (a: SubscriptionAccount): SubscriptionAccount => (provider === undefined ? a : { ...a, provider })
  if (c?.status !== "ready") return withProvider({ kind: "none" })
  // Verified: "api_key". The OAuth value (assumed "oauth") was not seen: no OAuth provider is signed in on this machine.
  return withProvider({ kind: c.authType === "api_key" ? "api-key" : "subscription" })
}
