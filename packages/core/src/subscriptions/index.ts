// Subscription shape (docs/design/subscriptions.md): what each harness's own sources say about its login and usage
// windows. Pure functions. Reading the sources is service.ts. The row types are @vibest/schema/subscription's.
export const record = (u: unknown): Record<string, unknown> | undefined =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined

export const num = (u: unknown): number | undefined => {
  const n = typeof u === "string" && u.trim() !== "" ? Number(u) : u
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

export const clampPercent = (p: number): number => Math.min(100, Math.max(0, p))

export { claudeAccount, claudeUsage } from "./claude.ts"
export { cursorAccount, cursorUsage } from "./cursor.ts"
export { piAccount } from "./pi.ts"

/** One login is limited when any of its usage windows is; no rows means unknown, not limited. */
export const isLimited = (row: { readonly limits: ReadonlyArray<{ readonly status: string }> }) => row.limits.some((l) => l.status === "limited")

/**
 * A remembered limit still rules its login out until that login's own row was refreshed after it and says it is fine
 * again. A login with no row, or none named by the attempt, keeps the plain memory.
 */
export const stillLimited = (
  attempt: { readonly harness: string; readonly provider: string | undefined; readonly at: number },
  rows: ReadonlyArray<{ readonly harness: string; readonly provider: string; readonly updatedAt: number; readonly limits: ReadonlyArray<{ readonly status: string }> }>,
) => {
  const row = attempt.provider === undefined ? undefined : rows.find((r) => r.harness === attempt.harness && r.provider === attempt.provider)
  return !(row !== undefined && row.updatedAt > attempt.at && !isLimited(row))
}
