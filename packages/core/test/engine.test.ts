import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Harness } from "@vibest/core/harness"
import { HOOK_GRACE, Sessions } from "@vibest/core/sessions"
import { Duration, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { FakeRuntime, type FakeRuntimeOptions } from "./lib/fake-runtime.ts"
import { harnessLayer } from "./lib/harnesses.ts"
import { settled, until, writeEnd } from "./lib/observe.ts"
import { makeRepository, runtimeNode, sessionLayer } from "./lib/session.ts"

const OFF_THE_POLL_BEAT = "1 second"

const withPi = (runtime: FakeRuntimeOptions) =>
  sessionLayer([
    runtimeNode.replace(FakeRuntime.layer(runtime)),
    Harness.node.replace(harnessLayer({ hooked: ["pi"] })),
  ])

const test = <E, R>(name: string, program: Effect.Effect<void, E, R>) =>
  testEffect(withPi({ statusEvents: true }))(name, () => program)

const working = Effect.gen(function* () {
  const sessions = yield* Sessions
  const db = yield* Db
  const repo = yield* makeRepository
  const projectId = yield* projectOf(repo)
  yield* db.startEntry(projectId, "pi", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: "test/coord" },
  })
  const { id } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    parentSessionId: "creator",
    projectId,
    name: "task",
    prompt: "do it",
    runtime: "herdr",
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
    "a message queued during an execution is delivered right after the execution end, with no clock advance",
    Effect.gen(function* () {
      const { id, sessions, db, herdr } = yield* working
      yield* sessions.send(id, "next")
      yield* herdr.endExecution(id)
      yield* settled
      assert.notInclude(yield* texts(herdr), "next")
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* until(texts(herdr), (sent) => sent.includes("next"))
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
    }),
  )

  test(
    "an idle execution with no report is lost exactly HOOK_GRACE after it went idle",
    Effect.gen(function* () {
      const { id, db, herdr } = yield* working
      yield* TestClock.adjust(OFF_THE_POLL_BEAT)
      yield* herdr.endExecution(id)
      yield* settled
      yield* TestClock.adjust(Duration.subtract(HOOK_GRACE, Duration.millis(1)))
      yield* settled
      assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
      yield* TestClock.adjust("1 millis")
      yield* until(db.getSession(id), (row) => row?.executionState === "lost")
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
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* until(db.getSession(id), (row) => row?.executionState === "completed")
      yield* herdr.runtime.close((yield* db.getSession(id))!.address)
      yield* until(db.getSession(id), (row) => row?.exitedAt !== null)
      yield* settled
      yield* sessions.send(id, "again")
      yield* until(texts(herdr), (sent) => sent.includes("again"))
      assert.isNull((yield* db.getSession(id))!.exitedAt)
    }),
  )

  testEffect(withPi({ promptsIgnored: true }))(
    "an execution start reported while the text is still being handed over confirms the launch, with no clock advance",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const db = yield* Db
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const projectId = yield* projectOf(repo)
        yield* db.startEntry(projectId, "pi", false, {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        })
        const held = yield* herdr.hold("send")
        const { id } = yield* sessions.spawn({
          machine: { id: "local" },
          root: repo,
          parentSessionId: "creator",
          projectId,
          name: "task",
          prompt: "do it",
          runtime: "herdr",
          harness: "pi",
        })
        yield* held.reached
        yield* sessions.userPrompt(id, "do it")
        yield* held.release()
        yield* settled
        assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
        assert.isFalse(
          (yield* herdr.callsTo("send")).some((call) => call.keys !== undefined),
          "no Enter resent",
        )
      }),
  )
})
