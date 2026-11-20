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
