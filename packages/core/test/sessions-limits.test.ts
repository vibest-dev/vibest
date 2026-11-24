import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { harnessIdOf, exitedAt, executionStateOf } from "@vibest/core/database/db-rows"
import { Integration } from "@vibest/core/integration"
import { Session } from "@vibest/core/session"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Effect, HashMap } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { harnessOf, spawnInput, spawnWorking, sqlNotices, test, limited } from "./lib/sessions-helpers.ts"

describe.concurrent("Session", () => {
  test(
    "a usage limit when the first terminal opens fails the launch naming the limit and starts nothing else",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const opening = yield* herdr.hold("open")
      const { id } = yield* (yield* Session.Service).spawn(yield* spawnInput(yield* makeRepository))
      yield* opening.reached
      yield* opening.release("rate_limit: usage limit reached")
      yield* until(db.session.getSession(id), (row) => row !== undefined && exitedAt(row) !== null)
      assert.include(
        (yield* db.inbox.latestInbox(id, "notice"))!.message,
        "failed to start pi: rate_limit: usage limit reached (no reset time reported)",
      )
      assert.lengthOf(yield* herdr.callsTo("open"), 1)

      const ended = yield* (yield* SqlClient.SqlClient)<{ data: string }>`SELECT data FROM event
        WHERE aggregate = ${id} AND type = 'execution.failed'`.pipe(Effect.orDie)

      assert.deepStrictEqual(
        ended.map((e) => JSON.parse(e.data).failure),
        [{ message: "rate_limit: usage limit reached", kind: "limit" }],
      )
    }),
  )

  test(
    "a usage limit at execution end fails the execution with its reset time, tells the creator once and leaves the agent running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const resetTime = Date.parse("2099-01-01T00:00:00.000Z")
      const { id, row: started, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      const pane = (yield* herdr.agent(id))!.terminal
      yield* (yield* Subscriptions.Service).report({
        harness: "cursor",
        limits: [{ window: "5h", percent: 100, status: "limited", resetTime }],
      })
      yield* herdr.endExecution(id)
      yield* (yield* Integration.Service).executionEnd(
        { id, harness: "cursor", process: started.process?.id },
        JSON.stringify({ hook_event_name: "afterAgentResponse", text: "", error: "rate_limit" }),
      )
      yield* sessions.check(id)
      const row = (yield* db.session.getSession(id))!
      assert.strictEqual(harnessIdOf(row), "cursor")
      assert.strictEqual(executionStateOf(row), "failed")
      assert.isNull(exitedAt(row))
      assert.isTrue(HashMap.has(yield* herdr.panes, pane))
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["cursor"],
      )

      const ended = yield* sql<{ data: string }>`SELECT data FROM event
        WHERE aggregate = ${id} AND type = 'execution.failed'`.pipe(Effect.orDie)

      assert.deepStrictEqual(
        ended.map((e) => JSON.parse(e.data).failure),
        [{ message: "rate_limit", kind: "limit", resetAt: resetTime }],
      )
      const notices = yield* sqlNotices(id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0]!, "5h")
      assert.include(
        notices[0]!,
        `(cursor) hit a usage limit: rate_limit (5h exhausted; resets ${new Date(resetTime).toISOString()})`,
      )
    }),
  )

  test(
    "abort and model_not_found stay failures and a missing hook stays lost while the subscription is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const aborted = yield* spawnWorking(repo)
      const missing = yield* spawnWorking(repo)
      const lost = yield* spawnWorking(repo)
      yield* (yield* Subscriptions.Service).report({ harness: "pi", limits: [limited] })

      const fail = (
        id: string,
        sessions: typeof aborted.sessions,
        db: typeof aborted.db,
        error: string,
        details?: string,
      ) =>
        Effect.gen(function* () {
          yield* writeEnd(id, "pi", details === undefined ? { error } : { error, error_details: details })
          yield* herdr.endExecution(id)
          yield* sessions.check(id)
          const row = (yield* db.session.getSession(id))!
          assert.strictEqual(harnessIdOf(row), "pi")
          assert.strictEqual(executionStateOf(row), "failed")
          const result = yield* db.inbox.latestInbox(id, "notice")
          assert.include(result!.message, error)
          assert.notInclude(result!.message, "usage limit:")
        })

      yield* fail(aborted.id, aborted.sessions, aborted.db, "aborted")
      yield* fail(missing.id, missing.sessions, missing.db, "model_not_found", "usage limit")
      yield* herdr.endExecution(lost.id)
      yield* lost.sessions.check(lost.id)
      assert.strictEqual(executionStateOf((yield* lost.db.session.getSession(lost.id))!), "open")
      yield* TestClock.adjust("11 seconds")
      yield* lost.sessions.check(lost.id)
      const row = (yield* lost.db.session.getSession(lost.id))!
      assert.strictEqual(harnessIdOf(row), "pi")
      assert.strictEqual(executionStateOf(row), "lost")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "pi", "pi"],
      )
    }),
  )
})
