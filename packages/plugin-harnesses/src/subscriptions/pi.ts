import type { Harness } from "@vibest/plugin"
import type { SubscriptionAccount } from "@vibest/schema/subscription"
import { Effect } from "effect"

import { parseJson, record, runCli } from "./index.ts"

export const piAccount = (check: unknown): SubscriptionAccount => {
  const c = record(check)
  const provider = typeof c?.provider === "string" ? c.provider : undefined
  const withProvider = (a: SubscriptionAccount): SubscriptionAccount =>
    provider === undefined ? a : { ...a, provider }
  if (c?.status !== "ready") return withProvider({ kind: "none" })
  return withProvider({ kind: c.authType === "api_key" ? "api-key" : "subscription" })
}

export const providersFromList = (text: string): ReadonlyArray<string> | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const first = lines[0]
  if (first === undefined) return undefined
  if (first.startsWith("No models available")) return []
  if (first.split(/\s+/)[0] !== "provider") return undefined
  const names = new Set<string>()
  for (const line of lines.slice(1)) {
    const provider = line.split(/\s+/)[0]
    if (provider !== undefined && provider !== "") names.add(provider)
  }
  return [...names]
}

export const piSubscription = (home: string) =>
  Effect.gen(function* () {
    const listed = yield* runCli("pi", ["--list-models"], home)
    const providers = listed === undefined ? undefined : providersFromList(listed)
    if (providers === undefined) return [{ provider: "", error: "pi --list-models failed" }]
    const reads: Array<Harness.SubscriptionRead> = []
    for (const provider of providers) {
      const check = parseJson(
        yield* runCli("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"], home),
      )
      reads.push(
        check === undefined
          ? { provider, error: `pi auth check ${provider} failed` }
          : { provider, account: piAccount(check) },
      )
    }
    return reads
  })
