import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Integration } from "@vibest/core/integration"
import { SessionLocks } from "@vibest/core/session/locks"
import { Sessions } from "@vibest/core/sessions"
import { Deferred, Effect, FileSystem, Ref } from "effect"
import { SqlClient } from "effect/sql"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { EXECUTIONS, until, untilVirtual, processEnds, writeEnd } from "./lib/observe.ts"
import { makeRepository, type TestServices } from "./lib/session.ts"
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
    const next = yield* Sessions.make({ maxSessions: undefined }).pipe(
      Effect.provideServiceEffect(SessionLocks, SessionLocks.make),
    )
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
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const spawned = yield* Deferred.make<string>()
      return yield* heldAtOpen(
        undefined,
        Effect.flatMap(Sessions, (sessions) =>
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
        const db = yield* Db
        const worktree = yield* sessionWorktree(id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isFalse(yield* fs.exists(worktree))
        assert.deepStrictEqual(yield* sqlNotices(id), [
          `${id} never finished starting (vibestd stopped while it started); its worktree was removed.`,
        ])
        assert.deepInclude(yield* db.getSession(id), { startedAt: null, status: "unknown" })
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
      const before = (yield* db.getSession(id))!
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* heldAtOpen(
        id,
        sessions.send(id, "next").pipe(Effect.orDie),
        Effect.gen(function* () {
          assert.isNull((yield* db.getSession(id))!.startedAt)
          const cutOff = (texts: ReadonlyArray<string>) => texts.find((t) => t.includes("never finished starting"))
          yield* nextVibestd(Effect.map(sqlNotices(id), (n) => cutOff(n) !== undefined))
          assert.deepStrictEqual(yield* processEnds(id), ["exited", "launch_failed"])
          const after = (yield* db.getSession(id))!
          assert.deepStrictEqual([after.address, after.startedAt], [before.address, before.startedAt])
          assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
          assert.strictEqual(
            cutOff(yield* sqlNotices(id)),
            `${id} never finished starting (vibestd stopped while it started).`,
          )
        }),
      )
    }),
    { hooked: ["pi"] },
  )

  const waitingForReady = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const opening = yield* herdr.hold("open")
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(repo))
      yield* opening.reached
      const looking = yield* herdr.hold("state", id)
      yield* opening.release()
      yield* looking.reached
      return yield* body(id).pipe(Effect.ensuring(looking.release("unreachable")))
    })

  const executionInputs = (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ input: string; status: string }>`SELECT input, status FROM ${sql.literal(EXECUTIONS)} m
        WHERE session_id = ${id} ORDER BY id`.pipe(Effect.orDie),
    )
  const typed = (text: string) =>
    Effect.map(
      Effect.flatMap(FakeRuntime, (herdr) => herdr.callsTo("send")),
      (calls) => calls.filter((c) => c.text === text).length,
    )

  test(
    "vibestd stopped in its ready wait leaves no execution and the task for the next vibestd",
    waitingForReady((id) =>
      Effect.gen(function* () {
        const db = yield* Db
        assert.deepStrictEqual(yield* executionInputs(id), [])
        assert.strictEqual(yield* db.untakenTask(id), "do it")
        yield* nextVibestd(Effect.map(typed("do it"), (n) => n === 1))
        assert.deepStrictEqual(yield* executionInputs(id), [{ input: "do it", status: "working" }])
        assert.isUndefined(yield* db.untakenTask(id))
      }),
    ),
    { hooked: ["pi"] },
  )

  test(
    "a task handed over at reconcile that does not start ends the execution not_started and is not handed over again",
    waitingForReady((id) =>
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        yield* Ref.set(herdr.skipPromptUpdates, 2)
        const next = yield* Sessions.make({ maxSessions: undefined }).pipe(
          Effect.provideServiceEffect(SessionLocks, SessionLocks.make),
        )
        yield* untilVirtual(executionInputs(id), (executions) => executions[0]?.status === "not_started")
        assert.strictEqual(yield* typed("do it"), 2)
        assert.isTrue((yield* sqlNotices(id)).some((t) => t.startsWith("task_not_started")))
        yield* next.check(id)
        yield* until(next.inMemory, (m) => m.locks === 0)
        assert.strictEqual(yield* typed("do it"), 2)
        assert.strictEqual((yield* executionInputs(id)).length, 1)
      }),
    ),
    { hooked: ["pi"] },
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
        const db = yield* Db
        yield* db.updateSession(id, { harnessId: "claude", provider: null, model: null })
        const successor = yield* db.currentProcessId(id)
        yield* (yield* Integration).ready(id, undefined)
        const handed = Effect.map(herdr.callsTo("send"), (calls) =>
          calls.filter((call) => call.text?.includes("do it") === true),
        )
        yield* nextVibestd(Effect.map(handed, (calls) => calls.length === 2))
        assert.lengthOf(yield* herdr.callsTo("open"), 1)
        assert.lengthOf(yield* herdr.callsTo("run"), 0)
        assert.strictEqual(yield* db.currentProcessId(id), successor)
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
        const db = yield* Db
        yield* db.endProcess(id, "limited")
        assert.notStrictEqual((yield* db.getSession(id))!.exitedAt, null)
        yield* nextVibestd(Effect.map(herdr.callsTo("open"), (calls) => calls.length === 2))
        assert.deepStrictEqual(
          (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
          ["pi", "claude"],
        )
        yield* until(db.getSession(id), (row) => row?.harnessId === "claude" && row.executionState === "open")
      }),
    ),
    { plugins: [chooseNext] },
  )
})
