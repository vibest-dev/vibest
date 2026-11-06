import { AgentRefused, isLimited, Plugin, type HarnessOption, type SubscriptionSnapshot } from "@vibest/plugin"
import { Effect } from "effect"

const fullest = (row: SubscriptionSnapshot) => row.limits.reduce((max, l) => Math.max(max, l.percent), -1)
const rowsOf = (subscriptions: ReadonlyArray<SubscriptionSnapshot>, harness: string) =>
  subscriptions.filter((s) => s.harness === harness)
const emptiest = (rows: ReadonlyArray<SubscriptionSnapshot>) =>
  rows.reduce((a, b) => (fullest(a) <= fullest(b) ? a : b))
const providerOf = (row: SubscriptionSnapshot) => (row.provider === "" ? undefined : row.provider)

const usable = (
  harnesses: ReadonlyArray<HarnessOption>,
  subscriptions: ReadonlyArray<SubscriptionSnapshot>,
  harness: string,
  provider: string | undefined,
) => {
  const option = harnesses.find((h) => h.harness === harness)
  if (option === undefined || !option.available) return false
  const rows = rowsOf(subscriptions, harness)
  if (provider === undefined) return rows.length === 0 || rows.some((row) => !isLimited(row))
  const row = rows.find((row) => row.provider === provider)
  return row === undefined || !isLimited(row)
}

const best = (harnesses: ReadonlyArray<HarnessOption>, subscriptions: ReadonlyArray<SubscriptionSnapshot>) => {
  const known: Array<{ readonly harness: string; readonly provider: string | undefined; readonly score: number }> = []
  const unknown: Array<string> = []
  for (const option of harnesses) {
    if (!option.available) continue
    const rows = rowsOf(subscriptions, option.harness).filter((row) => !isLimited(row))
    if (rows.length === 0) {
      if (rowsOf(subscriptions, option.harness).length === 0) unknown.push(option.harness)
      continue
    }
    const row = emptiest(rows)
    known.push({ harness: option.harness, provider: providerOf(row), score: fullest(row) })
  }
  if (known.length > 0) return known.reduce((a, b) => (a.score <= b.score ? a : b))
  const harness = unknown[0]
  return harness === undefined ? undefined : { harness, provider: undefined as string | undefined }
}

const whyNot = (harnesses: ReadonlyArray<HarnessOption>, subscriptions: ReadonlyArray<SubscriptionSnapshot>) =>
  harnesses
    .map((option) => {
      const rows = rowsOf(subscriptions, option.harness)
      const why = !option.available ? option.problem : rows.length > 0 && rows.every(isLimited) ? "limited" : "excluded"
      return `${option.harness}: ${why}`
    })
    .join(", ")

const resetOf = (resetTime: number | null) =>
  resetTime === null ? "no reset time" : `resets ${new Date(resetTime).toISOString()}`

const blocked = (
  harnesses: ReadonlyArray<HarnessOption>,
  subscriptions: ReadonlyArray<SubscriptionSnapshot>,
  harness: string,
  provider: string | undefined,
) => {
  const option = harnesses.find((h) => h.harness === harness)
  if (option === undefined || !option.available) return `${harness}: ${option?.problem || "unavailable"}`
  const text = rowsOf(subscriptions, harness)
    .filter((row) => (provider === undefined || row.provider === provider) && isLimited(row))
    .map((row) => {
      const limits = row.limits
        .filter((limit) => limit.status === "limited")
        .map((limit) => `${limit.window} limit exhausted, ${resetOf(limit.resetTime)}`)
        .join("; ")
      return `${row.provider === "" ? harness : `${harness}/${row.provider}`}: ${limits}`
    })
    .join("; ")
  return text === "" ? `${harness}: unavailable` : text
}

export const harnessChoicePlugin = Plugin.define({
  id: "harness-choice",
  effect: (context) =>
    Effect.gen(function* () {
      yield* context.agent.hook("start.before", (event) =>
        Effect.gen(function* () {
          const requested = event.harness
          if (requested !== undefined) {
            if (!usable(event.harnesses, event.subscriptions, requested, event.provider)) {
              return yield* new AgentRefused({
                reason: blocked(event.harnesses, event.subscriptions, requested, event.provider),
              })
            }
            if (event.provider === undefined) {
              const rows = rowsOf(event.subscriptions, requested).filter((row) => !isLimited(row))
              if (rows.length > 0) event.provider = providerOf(emptiest(rows))
            }
            return
          }
          const chosen = best(event.harnesses, event.subscriptions)
          if (chosen === undefined) {
            return yield* new AgentRefused({
              reason: `no harness available: ${whyNot(event.harnesses, event.subscriptions)}`,
            })
          }
          if (event.harness !== chosen.harness) event.model = undefined
          event.harness = chosen.harness
          event.provider = chosen.provider
        }),
      )
    }),
})
