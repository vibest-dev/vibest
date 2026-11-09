import type { Harness } from "@vibest/plugin"
import type { SubscriptionAccount } from "@vibest/schema/subscription"
import { Config, Effect, Option, Path } from "effect"

import { parseJson, readJsonFile, record, runCli } from "./index.ts"

export const piAccount = (check: unknown): SubscriptionAccount => {
  const c = record(check)
  const provider = typeof c?.provider === "string" ? c.provider : undefined
  const withProvider = (a: SubscriptionAccount): SubscriptionAccount =>
    provider === undefined ? a : { ...a, provider }
  if (c?.status !== "ready") return withProvider({ kind: "none" })
  return withProvider({ kind: c.authType === "api_key" ? "api-key" : "subscription" })
}

const piProviders = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const dir =
      Option.getOrUndefined(yield* Config.option(Config.String("PI_CODING_AGENT_DIR")).pipe(Effect.orDie)) ||
      (home ? path.join(home, ".pi", "agent") : "")
    if (!dir) return [] as ReadonlyArray<string>
    const auth = record(yield* readJsonFile(path.join(dir, "auth.json")))
    const models = record(record(yield* readJsonFile(path.join(dir, "models.json")))?.providers)
    const fallback = record(yield* readJsonFile(path.join(dir, "settings.json")))?.defaultProvider
    const names = new Set<string>()
    if (auth)
      for (const [name, value] of Object.entries(auth)) if (value !== null && typeof value === "object") names.add(name)
    if (models) for (const name of Object.keys(models)) names.add(name)
    if (typeof fallback === "string" && fallback !== "") names.add(fallback)
    return [...names]
  })

export const piSubscription = (home: string) =>
  Effect.gen(function* () {
    const reads: Array<Harness.SubscriptionRead> = []
    for (const provider of yield* piProviders(home)) {
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
