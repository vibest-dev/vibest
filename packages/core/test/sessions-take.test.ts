import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { Inbox } from "@vibest/core/inbox"
import { Session } from "@vibest/core/session"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { HARNESSES, PULLING_PI } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, restartSessions } from "./lib/session.ts"
import { spawnInput, test as plainTest } from "./lib/sessions-helpers.ts"

const test: typeof plainTest = (name, program, options, touches) =>
  plainTest(name, program, { ...options, harnesses: [...HARNESSES, PULLING_PI] }, touches)

const entryAsked = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const sessions = yield* Session.Service
  const db = yield* Db
  const repo = yield* makeRepository
  const entry = yield* db.startEntry(
    yield* projectOf(repo),
    "pulling-pi",
    false,
    {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    },
    { agent: "coordinator" },
  )
  yield* herdr.seedAgent("test/coord")
  const { id } = yield* sessions.spawn(yield* spawnInput(repo))
  yield* until(db.getSession(id), (row) => !!row && (row.process?.placedAt ?? null) !== null)
  yield* db.insertSend(entry.sessionId, "a question", undefined, id)
  return { db, sessions, inbox: yield* Inbox.Service, entryId: entry.sessionId, sender: id }
})

const inboxStatuses = (sender: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ status: string }>`SELECT status FROM inbox WHERE sender_session_id = ${sender} AND kind = 'send'`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.status)),
    ),
  )

const acceptedFacts = (session: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      n: number
    }>`SELECT COUNT(*) AS n FROM event WHERE type = 'execution.accepted' AND aggregate LIKE ${`%${session}%`}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]!.n),
    ),
  )

describe.concurrent("an idle session takes its next batch", () => {
  test(
    "a take hands the batch once, opens one execution, and takes nothing while it is open",
    Effect.gen(function* () {
      const { db, inbox, entryId } = yield* entryAsked
      const taken = yield* inbox.take(entryId, undefined)
      assert.include(taken!.text, "a question")
      assert.deepStrictEqual(yield* db.openExecution(entryId), taken!.execution)
      assert.isUndefined(yield* inbox.take(entryId, undefined))
    }),
  )

  test(
    "accepting an execution twice changes nothing, and accepting a closed one opens nothing",
    Effect.gen(function* () {
      const { db, inbox, entryId } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      assert.isTrue(yield* db.acceptExecution(entryId, execution))
      assert.isTrue(yield* db.acceptExecution(entryId, execution))
      assert.strictEqual(yield* acceptedFacts(entryId), 1)
      yield* db.closeExecution(entryId, execution, "completed", {})
      assert.isFalse(yield* db.acceptExecution(entryId, execution))
      assert.isUndefined(yield* db.openExecution(entryId))
    }),
  )

  test(
    "a batch the harness never accepts ends not_started and fails its messages",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId, sender } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["delivered"])
      yield* TestClock.adjust("9 seconds")
      yield* sessions.check(entryId)
      yield* until(inboxStatuses(sender), (statuses) => statuses[0] === "failed")
      assert.isUndefined(yield* db.openExecution(entryId))
      assert.isFalse(yield* db.acceptExecution(entryId, execution))
    }),
  )

  test(
    "a refusal reported again types the batch no second time, also through a rebuilt Session service",
    Effect.gen(function* () {
      const { sessions, inbox, entryId } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* sessions.typeTaken(entryId, execution)
      const restarted = yield* restartSessions
      yield* restarted.typeTaken(entryId, execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        1,
      )
    }),
  )

  test(
    "a batch an earlier vibestd took is never typed by the fallback, and ends not_started with its message failed",
    Effect.gen(function* () {
      const { db, sessions, entryId, sender } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const taken = (yield* db.takeInbox(entryId, undefined))!
      yield* sessions.typeTaken(entryId, taken.execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        0,
      )
      yield* TestClock.adjust("9 seconds")
      yield* sessions.check(entryId)
      yield* until(inboxStatuses(sender), (statuses) => statuses[0] === "failed")
      assert.isUndefined(yield* db.openExecution(entryId))
    }),
  )

  test(
    "a batch accepted and closed before the fallback send is not typed, and typing opens no second execution",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* db.acceptExecution(entryId, execution)
      yield* db.closeExecution(entryId, execution, "completed", {})
      yield* sessions.typeTaken(entryId, execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        0,
      )
      assert.isUndefined(yield* db.openExecution(entryId))
    }),
  )

  test(
    "typing the refused batch leaves the execution unaccepted until the harness reports it",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* sessions.typeTaken(entryId, execution)
      assert.isFalse(yield* db.executionAccepted(entryId))
      yield* sessions.userPrompt(entryId, "a question")
      assert.isTrue(yield* db.executionAccepted(entryId))
      assert.deepStrictEqual(yield* db.openExecution(entryId), execution)
    }),
  )

  for (const status of ["working", "blocked", "unknown"] as const) {
    test(
      `a pulled batch the harness never accepted is not accepted by a ${status} runtime state`,
      Effect.gen(function* () {
        const { db, sessions, inbox, entryId, sender } = yield* entryAsked
        const herdr = yield* FakeRuntime
        yield* inbox.take(entryId, undefined)
        yield* herdr.updateAgent("test/coord", (agent) => ({ ...agent, status, seq: agent.seq + 1 }))
        yield* sessions.check(entryId)
        assert.isFalse(yield* db.executionAccepted(entryId))
        yield* TestClock.adjust("9 seconds")
        yield* sessions.check(entryId)
        yield* until(inboxStatuses(sender), (statuses) => statuses[0] === "failed")
        assert.isUndefined(yield* db.openExecution(entryId))
      }),
    )
  }

  test(
    "only a pulling session takes: a typed session's take is empty and leaves its rows pending, and a pulling session's rows are never typed",
    Effect.gen(function* () {
      const { sessions, inbox, entryId, sender } = yield* entryAsked
      const herdr = yield* FakeRuntime
      yield* sessions.check(entryId)
      yield* TestClock.adjust("1 second")
      const typedToEntry = Effect.map(herdr.callsTo("send"), (calls) =>
        calls.filter((c) => c.terminal === "test/coord" && c.text?.includes("a question")),
      )
      assert.lengthOf(yield* typedToEntry, 0)
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["pending"])
      assert.isDefined(yield* inbox.take(entryId, undefined))
      assert.isUndefined(yield* inbox.take(sender, undefined))
    }),
  )
})
