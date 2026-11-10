import { capture } from "@vibest/plugin"
import type { SubscriptionLimit } from "@vibest/schema/subscription"
import { Effect, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export const record = (u: unknown): Record<string, unknown> | undefined =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined

export const num = (u: unknown): number | undefined => {
  const n = typeof u === "string" && u.trim() !== "" ? Number(u) : u
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

export const clampPercent = (p: number): number => Math.min(100, Math.max(0, p))

export const CLI_TIMEOUT = "10 seconds"

export type Usage =
  | { readonly limits: ReadonlyArray<SubscriptionLimit>; readonly error?: string }
  | { readonly error: string }

export const parseJson = (text: string | undefined): unknown => {
  if (text === undefined || text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const runCli = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  capture(command, args, {
    stdin: "ignore",
    cwd,
    env: { HOME: cwd },
    extendEnv: true,
    timeout: CLI_TIMEOUT,
  }).pipe(
    Effect.map((run) => (run === undefined ? undefined : run.stdout)),
    Effect.orElseSucceed(() => undefined),
  )

export const endpoint = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(request)
    if (response.status !== 200) {
      yield* response.text.pipe(Effect.ignore)
      return { status: response.status, body: undefined as unknown }
    }
    return { status: 200, body: yield* response.json }
  }).pipe(
    Effect.timeoutOption(CLI_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  )

export const authed = (request: HttpClientRequest.HttpClientRequest, token: string) =>
  HttpClientRequest.bearerToken(request, Redacted.make(token))

export const usageOf = (
  result: Option.Option<{ readonly status: number; readonly body: unknown }>,
  limits: (body: unknown) => ReadonlyArray<SubscriptionLimit>,
  error?: string,
): Usage =>
  Option.match(result, {
    onNone: () => {
      const usageError = "usage endpoint failed"
      return { error: error === undefined ? usageError : `${error}; ${usageError}` }
    },
    onSome: (r) => {
      if (r.status !== 200) {
        const usageError = `usage endpoint answered ${r.status}`
        return { error: error === undefined ? usageError : `${error}; ${usageError}` }
      }
      return error === undefined ? { limits: limits(r.body) } : { limits: limits(r.body), error }
    },
  })

export { claudeAccount } from "./claude.ts"
export { cursorAccount, cursorUsage } from "./cursor.ts"
export { piAccount } from "./pi.ts"
