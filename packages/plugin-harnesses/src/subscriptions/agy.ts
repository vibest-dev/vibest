import type { SubscriptionLimit } from "@vibest/schema/subscription"
import { Effect } from "effect"

import { parseJson, record, runCli } from "./index.ts"

const windowName = (group: string, window: string) => `${group} ${window}`

export const agyLimits = (usage: unknown): ReadonlyArray<SubscriptionLimit> => {
  const groups = record(record(record(usage)?.command)?.data)?.groups
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => {
    const name = record(group)?.name
    const buckets = record(group)?.buckets
    if (typeof name !== "string" || !Array.isArray(buckets)) return []
    return buckets.flatMap((bucket) => {
      const b = record(bucket)
      if (typeof b?.window !== "string" || typeof b.remaining_fraction !== "number") return []
      const reset = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : Number.NaN
      return [
        {
          window: windowName(name, b.window),
          percent: Math.round((1 - b.remaining_fraction) * 100),
          status: b.remaining_fraction <= 0 ? ("limited" as const) : ("available" as const),
          resetTime: Number.isNaN(reset) ? null : reset,
        },
      ]
    })
  })
}

export const agySubscription = (home: string, binary: string) =>
  Effect.gen(function* () {
    const usage = parseJson(yield* runCli(binary, ["-p", "/usage", "--output-format", "json"], home))
    const limits = agyLimits(usage)
    if (record(usage)?.status !== "SUCCESS" || limits.length === 0)
      return [{ provider: "", error: `${binary} usage failed` }]
    return [{ provider: "", account: { kind: "subscription" as const }, limits }]
  })
