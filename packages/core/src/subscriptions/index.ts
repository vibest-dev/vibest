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
