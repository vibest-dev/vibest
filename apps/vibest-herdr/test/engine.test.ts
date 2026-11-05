// Session handlers on the bus (engine.ts): runtime events, stored turn ends and queued messages drive the session, with
// no explicit check and no clock advance, except where a one-shot timer is the point.
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { HOOK_GRACE, Sessions } from "@vibest/core/sessions"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Duration, Effect, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import {
  FakeRuntime,
  makeRepository,
  projectOf,
  settled,
  testLayer,
  type TestServices,
  until,
  writeResult,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ hooked: ["pi"], statusEvents: true }))))

/** A Pi subagent in its first turn, its launch done. */
const working = Effect.gen(function* () {
  const sessions = yield* Sessions
  const db = yield* Db
  const repo = yield* makeRepository
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
    harness: "pi",
  })
  yield* until(db.getSession(id), (row) => !!row && row.startedAt !== null)
  yield* settled
  return { id, sessions, db, herdr: yield* FakeRuntime }
})

const texts = (herdr: FakeRuntime["Service"]) =>
  herdr.callsTo("send").pipe(Effect.map((calls) => calls.map((call) => call.text)))

const notices = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ message: string }>`SELECT content AS message FROM inbox
      WHERE kind = 'notice' AND sender_session_id = ${id} ORDER BY id`.pipe(Effect.orDie)
  })

describe("session handlers", () => {
  test(
    "a message queued during a turn is delivered right after the turn end, with no clock advance",
    Effect.gen(function* () {
      const { id, sessions, db, herdr } = yield* working
      yield* sessions.send(id, "next")
      // Idle before the report (the case the 5 s poll used to wait for): the report's turn end delivers it.
      yield* herdr.endTurn(id)
      yield* settled
      assert.notInclude(yield* texts(herdr), "next")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* until(texts(herdr), (sent) => sent.includes("next"))
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
  )

  test(
    "an idle turn with no report is lost exactly HOOK_GRACE after it went idle",
    Effect.gen(function* () {
      const { id, db, herdr } = yield* working
      // Off the poll's 5 s beat: only the grace timer can end it at the deadline.
      yield* TestClock.adjust("1 second")
      yield* herdr.endTurn(id)
      yield* settled
      yield* TestClock.adjust(Duration.subtract(HOOK_GRACE, Duration.millis(1)))
      yield* settled
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* TestClock.adjust("1 millis")
      yield* until(db.getSession(id), (row) => row?.turnState === "lost")
    }),
  )

  test(
    "an exit fails the turn and the queue at once",
    Effect.gen(function* () {
      const { id, sessions, db, herdr } = yield* working
      yield* sessions.send(id, "queued")
      yield* settled
      yield* herdr.runtime.close((yield* db.getSession(id))!.address)
      yield* until(db.getSession(id), (r) => r?.turnState === "failed" && r.exitedAt !== null)
      yield* until(db.pendingInbox(id), (rows) => rows.length === 0)
      yield* until(notices(id), (rows) => rows.some((r) => r.message.includes("exited before it was delivered")))
    }),
  )

  test(
    "blocked gives one notice",
    Effect.gen(function* () {
      const { id, herdr } = yield* working
      yield* herdr.updateAgent(id, (a) => ({ ...a, status: "blocked" }))
      yield* until(notices(id), (rows) => rows.length === 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, status: "blocked" }))
      yield* settled
      assert.lengthOf(yield* notices(id), 1)
      assert.include((yield* notices(id))[0]!.message, "waiting for a permission decision")
    }),
  )

  test(
    "a message to an exited session resumes it",
    Effect.gen(function* () {
      const { id, sessions, db, herdr } = yield* working
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* until(db.getSession(id), (row) => row?.turnState === "completed")
      yield* herdr.runtime.close((yield* db.getSession(id))!.address)
      yield* until(db.getSession(id), (row) => row?.exitedAt !== null)
      yield* settled
      yield* sessions.send(id, "again")
      yield* until(texts(herdr), (sent) => sent.includes("again"))
      assert.isNull((yield* db.getSession(id))!.exitedAt)
    }),
  )

  it.effect(
    "a turn start reported while the text is still being handed over confirms the launch, with no clock advance",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const db = yield* Db
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const projectId = yield* projectOf(repo)
        yield* db.coordinatorLaunch(projectId, "pi", false, {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        })
        // The runtime never shows the turn working: the hook's turn start is the only pickup proof, and it comes while
        // the runtime's send has not returned yet.
        const held = yield* herdr.hold("send")
        const { id } = yield* sessions.spawn({
          machine: { id: "local" },
          root: repo,
          projectId,
          name: "task",
          prompt: "do it",
          harness: "pi",
        })
        yield* held.reached
        yield* sessions.userPrompt(id, "do it")
        yield* held.release()
        yield* settled
        assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
        assert.isFalse(
          (yield* herdr.callsTo("send")).some((call) => call.keys !== undefined),
          "no Enter resent",
        )
      }).pipe(Effect.provide(testLayer({ hooked: ["pi"], promptsIgnored: true }))),
  )
})
