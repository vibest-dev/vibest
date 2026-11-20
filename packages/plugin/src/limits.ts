import { Predicate } from "effect"

type LimitWindow = {
  readonly status: string
  readonly resetTime?: number | null
  readonly window?: string
}

const resetPassed = (resetTime: number | null | undefined, now: number) =>
  Predicate.isNumber(resetTime) && resetTime <= now

const bucketWindow = (window: string | undefined) => window === "monthly-auto" || window === "monthly-api"

const countsAsLimited = (limit: LimitWindow, now: number) =>
  limit.status === "limited" && !bucketWindow(limit.window) && !resetPassed(limit.resetTime, now)

export const isLimited = (row: { readonly limits: ReadonlyArray<LimitWindow> }, now = Date.now()) =>
  row.limits.some((limit) => countsAsLimited(limit, now))

export const exhaustedText = (limits: ReadonlyArray<LimitWindow & { readonly window: string }>, now = Date.now()) =>
  limits
    .values()
    .filter((limit) => countsAsLimited(limit, now))
    .map((limit) => {
      const reset = limit.resetTime == null ? "no reset time" : `resets ${new Date(limit.resetTime).toISOString()}`

      return `${limit.window} limit exhausted, ${reset}`
    })
    .toArray()
    .join("; ")

export const stillLimited = (
  attempt: { readonly harness: string; readonly provider: string | undefined; readonly at: number },
  rows: ReadonlyArray<{
    readonly harness: string
    readonly provider: string
    readonly updatedAt: number
    readonly limits: ReadonlyArray<{ readonly status: string }>
  }>,
) => {
  const row =
    attempt.provider === undefined
      ? undefined
      : rows.find((r) => r.harness === attempt.harness && r.provider === attempt.provider)

  return !(row !== undefined && row.updatedAt > attempt.at && !isLimited(row))
}
