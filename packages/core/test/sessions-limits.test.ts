import { assert, describe } from "@effect/vitest"
import { harnessIdOf, exitedAt, executionStateOf } from "@vibest/core/database/rows"
import { Integration } from "@vibest/core/harness/integration"
import { Subscriptions } from "@vibest/core/harness/subscriptions"
import { InboxStore } from "@vibest/core/inbox/store"
import { Session } from "@vibest/core/session"
import { SessionStore } from "@vibest/core/session/store"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { until, writeEnd } from "@vibest/testkit/observe"
import { makeRepository } from "@vibest/testkit/session"
import { harnessOf, spawnInput, spawnWorking, sqlNotices, test, limited } from "@vibest/testkit/sessions-helpers"
import { Effect, HashMap } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

describe.concurrent("Session", () => {
  test(
    "a usage limit when the first terminal opens fails the launch naming the limit and starts nothing else",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessionStore = yield* SessionStore.Service
      const inboxStore = yield* InboxStore.Service
      const opening = yield* herdr.hold("open")
      const { id } = yield* (yield* Session.Service).spawn(yield* spawnInput(yield* makeRepository))
      yield* opening.reached
      yield* opening.release("rate_limit: usage limit reached")
      yield* until(sessionStore.getSession(id), (row) => row !== undefined && exitedAt(row) !== null)
      assert.include(
        (yield* inboxStore.latestInbox(id, "notice"))!.message,
        "failed to start pi: rate_limit: usage limit reached (no reset time reported)",
      )
      assert.lengthOf(yield* herdr.callsTo("open"), 1)

      const ended = yield* (yield* SqlClient.SqlClient)<{ data: string }>`SELECT data FROM event
        WHERE aggregate_id = ${id} AND type = 'session.execution.failed.1'`.pipe(Effect.orDie)

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
      const { id, row: started, sessions, sessionStore } = yield* spawnWorking(yield* makeRepository, "cursor")
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
      const row = (yield* sessionStore.getSession(id))!
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
        WHERE aggregate_id = ${id} AND type = 'session.execution.failed.1'`.pipe(Effect.orDie)

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
        sessionStore: typeof aborted.sessionStore,
        inboxStore: typeof aborted.inboxStore,
        error: string,
        details?: string,
      ) =>
        Effect.gen(function* () {
          yield* writeEnd(id, "pi", details === undefined ? { error } : { error, error_details: details })
          yield* herdr.endExecution(id)
          yield* sessions.check(id)
          const row = (yield* sessionStore.getSession(id))!
          assert.strictEqual(harnessIdOf(row), "pi")
          assert.strictEqual(executionStateOf(row), "failed")
          const result = yield* inboxStore.latestInbox(id, "notice")
          assert.include(result!.message, error)
          assert.notInclude(result!.message, "usage limit:")
        })

      yield* fail(aborted.id, aborted.sessions, aborted.sessionStore, aborted.inboxStore, "aborted")
      yield* fail(
        missing.id,
        missing.sessions,
        missing.sessionStore,
        missing.inboxStore,
        "model_not_found",
        "usage limit",
      )
      yield* herdr.endExecution(lost.id)
      yield* lost.sessions.check(lost.id)
      assert.strictEqual(executionStateOf((yield* lost.sessionStore.getSession(lost.id))!), "open")
      yield* TestClock.adjust("11 seconds")
      yield* lost.sessions.check(lost.id)
      const row = (yield* lost.sessionStore.getSession(lost.id))!
      assert.strictEqual(harnessIdOf(row), "pi")
      assert.strictEqual(executionStateOf(row), "lost")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "pi", "pi"],
      )
    }),
  )
})
