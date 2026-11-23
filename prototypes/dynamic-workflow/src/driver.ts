export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export type Outcome = "completed" | "failed" | "interrupted" | "blocked" | "limit"

export interface Reply {
  readonly execution: number
  readonly outcome: Outcome
  readonly text: string
  readonly failure: string | undefined
}

export interface SpawnRequest {
  readonly title: string
  readonly prompt: string
  readonly harness?: string | undefined
  readonly agent?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

export interface Driver {
  readonly spawn: (request: SpawnRequest) => Promise<string>
  readonly send: (session: string, message: string) => Promise<void>
  readonly reply: (session: string, after: number, signal: AbortSignal) => Promise<Reply>
  readonly interrupt: (session: string) => Promise<void>
  readonly archive: (session: string) => Promise<void>
}

const USAGE_LIMIT = /rate[_ -]?limits?\b|usage limits?\b|too many requests/i

export const isUsageLimit = (failure: string | undefined) => {
  const head = failure?.split(":")[0]

  return head !== undefined && head !== "" && USAGE_LIMIT.test(head)
}

export const BLOCKED_PREFIX = "BLOCKED:"

export const outcomeOf = (status: string, text: string, failure: string | undefined): Outcome => {
  if (status === "interrupted") return "interrupted"

  if (status === "failed") return isUsageLimit(failure) ? "limit" : "failed"

  return text.trimStart().startsWith(BLOCKED_PREFIX) ? "blocked" : "completed"
}

export const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })

export const sleep = (ms: number, signal: AbortSignal) =>
  Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), aborted(signal)])
