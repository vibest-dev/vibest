import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt, harnessIdOf, runtimeOf, terminalOf } from "@vibest/core/database/db-rows"
import { Integration } from "@vibest/core/integration"
import { Session } from "@vibest/core/session"
import { Deferred, Effect, FileSystem } from "effect"
import { SqlClient } from "effect/sql"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { CLAUDE, CURSOR, PI } from "./lib/harnesses.ts"
import { EXECUTIONS, until, processEnds, writeEnd } from "./lib/observe.ts"
import { makeRepository, restartSessions, type TestServices } from "./lib/session.ts"
import {
  chooseNext,
  harnessOf,
  idleSession,
  sessionWorktree,
  spawnInput,
  spawnWorking,
  sqlNotices,
  test,
} from "./lib/sessions-helpers.ts"

const nextVibestd = (done: Effect.Effect<boolean, never, TestServices>) =>
  Effect.gen(function* () {
    const next = yield* restartSessions
    yield* until(done, (yes) => yes)
    yield* until(next.inMemory, (m) => m.locks === 0)
  })

const heldAtOpen = <A, E, R, R2>(
  target: string | undefined,
  start: Effect.Effect<unknown, never, R2>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const held = yield* (yield* FakeRuntime).hold("open", target)
    yield* start
    yield* held.reached

    return yield* body.pipe(Effect.ensuring(held.release("unreachable")))
  })

describe.concurrent("after a vibestd stop", () => {
  const cutOffSpawn = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* db.session.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      const spawned = yield* Deferred.make<string>()

      return yield* heldAtOpen(
        undefined,
        Effect.flatMap(Session.Service, (sessions) =>
          spawnInput(repo).pipe(
            Effect.flatMap(sessions.spawn),
            Effect.flatMap(({ id }) => Deferred.succeed(spawned, id)),
            Effect.orDie,
          ),
        ),
        Effect.flatMap(Deferred.await(spawned), body),
      )
    })

  test(
    "a spawn cut off before its terminal ends launch_failed, its worktree removed, with one notice",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const db = yield* Db.Service
        const worktree = yield* sessionWorktree(id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isFalse(yield* fs.exists(worktree))
        const notices = yield* sqlNotices(id)
        assert.strictEqual(notices.length, 1)
        assert.include(notices[0], `${id.slice(0, 8)} `)
        assert.include(
          notices[0],
          "never finished starting (vibestd stopped while it started); its worktree was removed.",
        )
        const row = (yield* db.session.getSession(id))!
        assert.isNull(row.process?.placedAt ?? null)
        assert.strictEqual(row.status, "unknown")
      }),
    ),
  )

  test(
    "a spawn cut off before its terminal keeps its worktree while a process works in it, and names it",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* (yield* FakeProcesses).setCwdUsers([4242])
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
        const [text] = yield* sqlNotices(id)
        assert.include(text!, "never finished starting (vibestd stopped while it started)")
        assert.include(text!, "process 4242 has its working directory in it")
      }),
    ),
  )

  test(
    "a resume cut off before its terminal falls back to its previous start and keeps its worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const before = (yield* db.session.getSession(id))!
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* heldAtOpen(
        id,
        sessions.send(id, "next").pipe(Effect.orDie),
        Effect.gen(function* () {
          assert.isNull((yield* db.session.getSession(id))!.process?.placedAt ?? null)
          const cutOff = (texts: ReadonlyArray<string>) => texts.find((t) => t.includes("never finished starting"))
          yield* nextVibestd(Effect.map(sqlNotices(id), (n) => cutOff(n) !== undefined))
          assert.deepStrictEqual(yield* processEnds(id), ["exited", "launch_failed"])
          const after = (yield* db.session.getSession(id))!
          assert.deepStrictEqual(
            [terminalOf(after), after.process?.placedAt ?? null],
            [terminalOf(before), before.process?.placedAt ?? null],
          )
          assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
          assert.match(
            cutOff(yield* sqlNotices(id))!,
            /never finished starting \(vibestd stopped while it started\)\.$/,
          )
        }),
      )
    }),
    { hooked: ["pi"], harnesses: [{ ...PI, delivery: "pull" }, CLAUDE, CURSOR] },
  )

  const executionInputs = (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ input: string; status: string }>`SELECT input, status FROM ${sql.literal(EXECUTIONS)} m
        WHERE session_id = ${id} ORDER BY id`.pipe(Effect.orDie),
    )

  const limitedMidMove = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id } = yield* spawnWorking(yield* makeRepository)
      const looking = yield* herdr.hold("state", id)
      yield* herdr.endExecution(id)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* looking.reached

      return yield* body(id).pipe(Effect.ensuring(looking.release("unreachable")))
    })

  test(
    "a usage-limit move cut off after its next process started hands the input to that process and starts no other",
    limitedMidMove((id) =>
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const db = yield* Db.Service
        const row = (yield* db.session.getSession(id))!
        yield* db.session.startProcess(id, {
          harness: "claude",
          runtime: runtimeOf(row),
          terminal: terminalOf(row).id,
          ...(row.process?.routing && { routing: row.process.routing }),
        })
        const successor = yield* db.session.currentProcessId(id)
        yield* (yield* Integration.Service).ready(id, undefined)

        const handed = Effect.map(herdr.callsTo("send"), (calls) =>
          calls.filter((call) => call.text?.includes("do it") === true),
        )

        yield* nextVibestd(Effect.map(handed, (calls) => calls.length === 1))
        assert.lengthOf(yield* herdr.callsTo("open"), 1)
        assert.lengthOf(yield* herdr.callsTo("run"), 0)
        assert.strictEqual(yield* db.session.currentProcessId(id), successor)
        assert.deepStrictEqual(
          (yield* executionInputs(id)).map((row) => row.status),
          ["failed", "working"],
        )
      }),
    ),
    { plugins: [chooseNext] },
  )

  test(
    "a session whose process ended at a usage limit with no next process is found at start and moved",
    limitedMidMove((id) =>
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const db = yield* Db.Service
        yield* db.session.endProcess(id, "limited")
        assert.notStrictEqual(exitedAt((yield* db.session.getSession(id))!), null)
        yield* nextVibestd(Effect.map(herdr.callsTo("open"), (calls) => calls.length === 2))
        assert.deepStrictEqual(
          (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
          ["pi", "claude"],
        )
        yield* until(
          db.session.getSession(id),
          (row) => row !== undefined && harnessIdOf(row) === "claude" && executionStateOf(row) === "open",
        )
      }),
    ),
    { plugins: [chooseNext] },
  )
})
