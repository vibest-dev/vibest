import { it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt, type SessionRow } from "@vibest/core/database/db-rows"
import { sessionEnvelope, unwrapped } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import type { HarnessId } from "@vibest/schema/session"
import { Effect, type Scope } from "effect"
import { SqlClient } from "effect/sql"

import { KIND as RUNTIME } from "../../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./directory.ts"
import { FakeRuntime } from "./fake-runtime.ts"
import { PULLING_PI } from "./harnesses.ts"
import { settled, EXECUTIONS, until, writeEnd } from "./observe.ts"
import { sessionFrom, type TestOptions, type TestServices } from "./session.ts"

export const harnessArgv = (argv: ReadonlyArray<string>) =>
  argv[0] === "sh" && argv[1] === "-c" && argv[2]?.includes("VIBEST_CLI") ? argv.slice(4) : argv

export const harnessOf = (argv: ReadonlyArray<string>) => {
  const binary = harnessArgv(argv)[0]

  return binary === "cursor-agent" ? "cursor" : binary
}

export const entryOfProject = (repo: string) =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    const projectId = yield* projectOf(repo)
    const found = yield* db.session.latestRoot(projectId)

    if (found !== undefined) return found.id

    return (yield* db.session.startRoot(
      projectId,
      PULLING_PI.id,
      false,
      {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      },
      { agent: "coordinator" },
    )).sessionId
  })

export const taskOf = (repo: string, text = "do it") =>
  Effect.map(entryOfProject(repo), (id) => sessionEnvelope(id, text))

export const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.gen(function* () {
    const parentSessionId = yield* entryOfProject(repo)

    return {
      machine: { id: "local" },
      agent: "general",
      root: repo,
      parentSessionId,
      projectId: yield* projectOf(repo),
      name: "task",
      prompt: "do it",
      harness,
      runtime: "herdr",
    } as const
  })

export const claudeEnd = (reason: string) => ({
  hook_event_name: "ExecutionComplete",
  session_id: "c1",
  reason,
  last_assistant_message: "",
})

export const spawnWorking = (repo: string, harness: HarnessId = "pi") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const db = yield* Db.Service

    const { id } = yield* sessions.spawn(yield* spawnInput(repo, harness))

    yield* until(
      db.session.getSession(id),
      (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null),
    )
    yield* sessions.check(id)
    yield* (yield* FakeRuntime).seedAgent("test/coord")
    yield* settled
    const row = (yield* db.session.getSession(id))!

    return { id, row, sessions, db, entryId: yield* entryOfProject(repo) }
  })

export const idleSession = (repo: string) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const w = yield* spawnWorking(repo, "pi")
    yield* herdr.endExecution(w.id)
    const open = yield* w.db.session.openExecution(w.id)
    yield* writeEnd(w.id, "pi", { text: "status: completed", ...(open !== undefined && { execution: open }) })
    yield* w.sessions.check(w.id)
    yield* settled

    return w
  })

export const sessionWorktree = (id: string) =>
  Effect.gen(function* () {
    const located = yield* (yield* Db.Service).session.sessionDirectory(id)

    if (!located) return yield* Effect.die(`no worktree for ${id}`)

    return located
  })

export const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(sessionFrom(options))))

export const SPAWN_HEAVY_TEST_TIMEOUT = 90_000

export const slowTest = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(sessionFrom(options))), { timeout: SPAWN_HEAVY_TEST_TIMEOUT })

export const pick = (w: SessionRow | undefined) => ({
  status: w?.status,
  executionState: w === undefined ? undefined : executionStateOf(w),
})

export const executionAndSentCounts = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [executions] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${sessionId}`.pipe(Effect.orDie)

    const [sent] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${sessionId} OR about_session_id = ${sessionId}`.pipe(
      Effect.orDie,
    )

    return { executions: executions!.n, sent: sent!.n }
  })

export const sqlNotices = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* sql<{
      message: string
    }>`SELECT m.content AS message FROM inbox m WHERE m.sender_type = 'vibest' AND m.about_session_id = ${sessionId} ORDER BY m.id`.pipe(
      Effect.orDie,
    )

    return rows.map((r) => unwrapped(r.message))
  })

export const limited = { window: "5h", percent: 100, status: "limited" as const, resetTime: null }
