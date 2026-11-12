import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Sessions } from "@vibest/core/sessions"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { HARNESSES, PULLING_PI } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, test as plainTest } from "./lib/sessions-helpers.ts"

const test: typeof plainTest = (name, program, options, touches) =>
  plainTest(name, program, { ...options, harnesses: [...HARNESSES, PULLING_PI] }, touches)

const entryAsked = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const sessions = yield* Sessions
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
  yield* until(db.getSession(id), (row) => !!row && row.startedAt !== null)
  yield* db.insertSend(entry.sessionId, "a question", undefined, id)
  return { db, sessions, inbox: yield* Inbox, entryId: entry.sessionId, sender: id }
})

const inboxStatuses = (sender: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ status: string }>`SELECT status FROM inbox WHERE sender_session_id = ${sender} AND kind = 'send'`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.status)),
    ),
  )

const acceptedFacts = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ n: number }>`SELECT COUNT(*) AS n FROM event WHERE type = 'execution.accepted'`.pipe(
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
      assert.strictEqual(yield* acceptedFacts, 1)
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
})
