import type { SubscriptionAccount } from "@vibest/schema/subscription"

import { record } from "./index.ts"

export const piAccount = (check: unknown): SubscriptionAccount => {
  const c = record(check)
  const provider = typeof c?.provider === "string" ? c.provider : undefined
  const withProvider = (a: SubscriptionAccount): SubscriptionAccount =>
    provider === undefined ? a : { ...a, provider }
  if (c?.status !== "ready") return withProvider({ kind: "none" })
  return withProvider({ kind: c.authType === "api_key" ? "api-key" : "subscription" })
}
