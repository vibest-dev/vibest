import {
  AgentRefused,
  isLimited,
  Plugin,
  stillLimited,
  type HarnessOption,
  type SubscriptionSnapshot,
} from "@vibest/plugin"
import { Effect } from "effect"

const fullest = (row: SubscriptionSnapshot) => row.limits.reduce((max, l) => Math.max(max, l.percent), -1)
const rowsOf = (subscriptions: ReadonlyArray<SubscriptionSnapshot>, harness: string) =>
  subscriptions.filter((s) => s.harness === harness)
const pair = (harness: string, provider: string) => `${harness}\0${provider}`
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

const best = (
  harnesses: ReadonlyArray<HarnessOption>,
  subscriptions: ReadonlyArray<SubscriptionSnapshot>,
  excludedPairs: ReadonlySet<string>,
  excludedHarnesses: ReadonlySet<string>,
) => {
  const known: Array<{ readonly harness: string; readonly provider: string | undefined; readonly score: number }> = []
  const unknown: Array<string> = []
  for (const option of harnesses) {
    if (!option.available || excludedHarnesses.has(option.harness)) continue
    const rows = rowsOf(subscriptions, option.harness).filter(
      (row) => !isLimited(row) && !excludedPairs.has(pair(option.harness, row.provider)),
    )
    if (rows.length === 0) {
      if (rowsOf(subscriptions, option.harness).length === 0 && !excludedPairs.has(pair(option.harness, "")))
        unknown.push(option.harness)
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

export const harnessChoicePlugin = Plugin.define({
  id: "harness-choice",
  effect: (context) =>
    Effect.gen(function* () {
      yield* context.agent.hook("start.before", (event) =>
        Effect.gen(function* () {
          const requested = event.harness
          if (requested !== undefined && usable(event.harnesses, event.subscriptions, requested, event.provider)) {
            if (event.provider === undefined) {
              const rows = rowsOf(event.subscriptions, requested).filter((row) => !isLimited(row))
              if (rows.length > 0) event.provider = providerOf(emptiest(rows))
            }
            return
          }
          const named =
            requested !== undefined &&
            event.provider !== undefined &&
            rowsOf(event.subscriptions, requested).some((row) => row.provider === event.provider && isLimited(row))
          const chosen = best(event.harnesses, event.subscriptions, new Set(), new Set(named ? [requested!] : []))
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
      yield* context.agent.hook("fail", (event) =>
        Effect.sync(() => {
          if (event.reason !== "limited" || event.move !== undefined) return
          const excludedPairs = new Set<string>()
          const excludedHarnesses = new Set(event.attempts.filter((a) => a.outcome !== "limited").map((a) => a.harness))
          for (const attempt of event.attempts) {
            if (attempt.outcome !== "limited") continue
            if (attempt.provider === undefined) excludedHarnesses.add(attempt.harness)
            else if (stillLimited(attempt, event.subscriptions))
              excludedPairs.add(pair(attempt.harness, attempt.provider))
          }
          if (event.provider === undefined) excludedHarnesses.add(event.harness)
          else excludedPairs.add(pair(event.harness, event.provider))
          const chosen = best(event.harnesses, event.subscriptions, excludedPairs, excludedHarnesses)
          if (chosen !== undefined) event.move = chosen
        }),
      )
    }),
})
