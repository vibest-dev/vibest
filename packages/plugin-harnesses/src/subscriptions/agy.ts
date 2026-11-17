import type { SubscriptionLimit } from "@vibest/schema/subscription"
import { Effect, Predicate, Schema } from "effect"

import { parseJson, record, runCli, type Spawner } from "./index.ts"

const windowName = (group: string, window: string) => `${group} ${window}`

export const agyLimits = (usage: Schema.Json | undefined): ReadonlyArray<SubscriptionLimit> => {
  const groups = record(record(record(usage)?.command)?.data)?.groups

  if (!Array.isArray(groups)) return []

  const windows = groups.map((group) => {
    const name = record(group)?.name
    const buckets = record(group)?.buckets

    if (!Predicate.isString(name) || !Array.isArray(buckets)) return []

    return buckets.flatMap((bucket) => {
      const b = record(bucket)

      if (!Predicate.isString(b?.window) || !Predicate.isNumber(b.remaining_fraction)) return []
      const reset = Predicate.isString(b.reset_time) ? Date.parse(b.reset_time) : Number.NaN

      return [
        {
          window: windowName(name, b.window),
          percent: Math.round((1 - b.remaining_fraction) * 100),
          exhausted: b.remaining_fraction <= 0,
          resetTime: Number.isNaN(reset) ? null : reset,
        },
      ]
    })
  })

  const noneLeft = windows.every((group) => group.some((window) => window.exhausted))

  return windows.flat().map(({ exhausted, ...window }) => ({
    ...window,
    status: noneLeft && exhausted ? ("limited" as const) : ("available" as const),
  }))
}

export const agySubscription = (spawner: Spawner) => (home: string, binary: string) =>
  Effect.gen(function* () {
    const usage = parseJson(yield* runCli(spawner, binary, ["-p", "/usage", "--output-format", "json"], home))
    const limits = agyLimits(usage)

    if (record(usage)?.status !== "SUCCESS" || limits.length === 0)
      return [{ provider: "", error: `${binary} usage failed` }]

    return [{ provider: "", account: { kind: "subscription" as const }, limits }]
  })
