import { it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import type { HarnessId } from "@vibest/core/harness"
import { Sessions } from "@vibest/core/sessions"
import { isLimited, Plugin, stillLimited } from "@vibest/plugin"
import { Effect, type Scope } from "effect"
import { SqlClient } from "effect/sql"

import { KIND as RUNTIME } from "../../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./directory.ts"
import { FakeRuntime } from "./fake-runtime.ts"
import { CLAUDE } from "./harnesses.ts"
import { settled, EXECUTIONS, until, writeEnd } from "./observe.ts"
import { sessionFrom, type TestOptions, type TestServices } from "./session.ts"

export const harnessOf = (argv: ReadonlyArray<string>) => (argv[0] === "cursor-agent" ? "cursor" : argv[0])

export const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(
    projectOf(repo),
    (projectId) =>
      ({
        machine: { id: "local" },
        root: repo,
        parentSessionId: "creator",
        projectId,
        name: "task",
        prompt: "do it",
        harness,
        runtime: "herdr",
      }) as const,
  )

export const claudeEnd = (reason: string) =>
  (
    CLAUDE.executionEnd!({
      hook_event_name: "ExecutionComplete",
      session_id: "c1",
      reason,
      last_assistant_message: "",
    }) as {
      readonly end: object
    }
  ).end

export const spawnWorking = (
  repo: string,
  harness: HarnessId = "pi",
  extra: { readonly archive?: boolean; readonly underMain?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    const entry = yield* db.startEntry(yield* projectOf(repo), "pi", false, {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    })
    const { id } = yield* sessions.spawn({
      ...(yield* spawnInput(repo, harness)),
      ...(extra.archive ? { archive: true } : {}),
      ...(extra.underMain ? { parentSessionId: entry.sessionId } : {}),
    })
    yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
    yield* sessions.check(id)
    yield* (yield* FakeRuntime).seedAgent("test/coord")
    yield* settled
    const row = (yield* db.getSession(id))!
    return { id, row, sessions, db }
  })

export const idleSession = (repo: string, extra: { readonly archive?: boolean } = {}) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const w = yield* spawnWorking(repo, "pi", extra)
    yield* herdr.endExecution(w.id)
    yield* writeEnd(w.id, "pi", { text: "status: completed" })
    yield* w.sessions.check(w.id)
    yield* settled
    return w
  })

export const sessionWorktree = (id: string) =>
  Effect.gen(function* () {
    const located = yield* (yield* Db).sessionDirectory(id)
    if (!located) return yield* Effect.die(`no worktree for ${id}`)
    return located
  })

export const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
  touchesProcessWideSeam = false,
) =>
  it.effect(
    name,
    () => program.pipe(Effect.provide(sessionFrom(options))),
    touchesProcessWideSeam ? { concurrent: false } : undefined,
  )

export const SPAWN_HEAVY_TEST_TIMEOUT = 90_000

export const slowTest = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(sessionFrom(options))), { timeout: SPAWN_HEAVY_TEST_TIMEOUT })

export const pick = (w: { readonly status: string; readonly executionState: string } | undefined) => ({
  status: w?.status,
  executionState: w?.executionState,
})
export const executionAndSentCounts = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [executions] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${sessionId}`.pipe(Effect.orDie)
    const [sent] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${sessionId}`.pipe(Effect.orDie)
    return { executions: executions!.n, sent: sent!.n }
  })
export const sqlNotices = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      message: string
    }>`SELECT m.content AS message FROM inbox m WHERE m.kind = 'notice' AND m.sender_session_id = ${sessionId} ORDER BY m.id`.pipe(
      Effect.orDie,
    )
    return rows.map((r) => r.message)
  })

export const limited = { window: "5h", percent: 100, status: "limited" as const, resetTime: null }

export const chooseNext = Plugin.define({
  id: "choose-next",
  effect: (ctx) =>
    ctx.agent.hook("fail", (event) =>
      Effect.sync(() => {
        if (event.reason !== "limited") return undefined
        const pair = (harness: string, provider: string) => `${harness}\0${provider}`
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
        const fullest = (row: (typeof event.subscriptions)[number]) =>
          row.limits.reduce((max, limit) => Math.max(max, limit.percent), -1)
        const known: Array<{ harness: string; provider: string | undefined; score: number }> = []
        const unknown: Array<string> = []
        for (const option of event.harnesses) {
          if (!option.available || excludedHarnesses.has(option.harness)) continue
          const rows = event.subscriptions.filter(
            (row) =>
              row.harness === option.harness &&
              !isLimited(row) &&
              !excludedPairs.has(pair(option.harness, row.provider)),
          )
          if (rows.length === 0) {
            if (
              event.subscriptions.every((row) => row.harness !== option.harness) &&
              !excludedPairs.has(pair(option.harness, ""))
            )
              unknown.push(option.harness)
            continue
          }
          const row = rows.reduce((a, b) => (fullest(a) <= fullest(b) ? a : b))
          known.push({
            harness: option.harness,
            provider: row.provider === "" ? undefined : row.provider,
            score: fullest(row),
          })
        }
        const picked = known.length > 0 ? known.reduce((a, b) => (a.score <= b.score ? a : b)) : undefined
        const fallback = unknown[0]
        const chosen = picked ?? (fallback === undefined ? undefined : { harness: fallback, provider: undefined })
        return chosen
      }),
    ),
})

export type FailSeen = Array<{ parent: string | undefined; attempts: ReadonlyArray<[string, string]> }>
