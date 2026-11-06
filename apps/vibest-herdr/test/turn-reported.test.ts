import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import type { HarnessId } from "@vibest/core/harness"
import { Sessions } from "@vibest/core/sessions"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Clock, Effect, type Scope } from "effect"

import {
  eventsOf,
  FakeRuntime,
  makeRepository,
  projectOf,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  writeResult,
} from "./fakes.ts"

const spawnWorking = (repo: string, harness: HarnessId = "pi") =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    const projectId = yield* projectOf(repo)
    yield* db.coordinatorLaunch(projectId, "pi", false, {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    })
    const { id } = yield* sessions.spawn({
      machine: { id: "local" },
      root: repo,
      projectId,
      name: "task",
      prompt: "do it",
      harness,
    })
    yield* until(db.getSession(id), (row) => !!row && (row.startedAt !== null || row.exitedAt !== null))
    yield* sessions.check(id)
    return { id, sessions, db }
  })

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>, options?: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ hooked: ["pi", "claude"], ...options }))))

const resultCount = (id: string) => eventsOf(id, "turn.end").pipe(Effect.map((rows) => rows.length))

describe("turn.reported", () => {
  test(
    "two reports give one result, the later one, and a second check writes nothing",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: first" }, 1_000)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: second" }, 2_000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const [end] = yield* eventsOf(id, "turn.end")
      assert.strictEqual(end?.data.output, undefined)
      assert.strictEqual(typeof end?.data.report, "number")
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "summary: second")
      assert.notInclude(message, "summary: first")
      yield* sessions.check(id)
      assert.strictEqual(yield* resultCount(id), 1)
    }),
  )

  test(
    "a report written before the same harness reports ready again (a plugin reload or a new conversation) still counts",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: before the reload" })
      yield* db.patchLive(id, { ready: yield* Clock.currentTimeMillis })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.include((yield* db.latestInbox(id, "result"))!.message, "summary: before the reload")
    }),
  )

  test(
    "a report from the harness a move left is ignored",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: old harness" })
      yield* db.updateSession(id, { harnessId: "claude" })
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "working" }))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.isUndefined(yield* db.latestInbox(id, "result"))
    }),
  )

  test(
    "a consumed report is not the next turn's, even when that turn was prompted before the report's time",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: first" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual(yield* resultCount(id), 1)
      yield* db.updateSession(id, { turnState: "open", turnPromptedAt: 0 })
      yield* sessions.check(id)
      assert.strictEqual(yield* resultCount(id), 1)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
  )
})
