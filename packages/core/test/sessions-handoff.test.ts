import { assert } from "@effect/vitest"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Session } from "@vibest/core/session"
import { Starts } from "@vibest/core/session/starts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { idleSession, spawnInput, test } from "./lib/sessions-helpers.ts"

const inboxStatus = (sessionId: string, content?: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    content === undefined
      ? sql<{ status: string }>`SELECT status FROM inbox WHERE session_id = ${sessionId} ORDER BY id`
      : sql<{ status: string }>`SELECT status FROM inbox WHERE session_id = ${sessionId} AND content = ${content}`,
  )

test(
  "opening a terminal reserves the first message and a refused open does not deliver it",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const runtime = yield* FakeRuntime
    const sessions = yield* Session.Service
    const held = yield* runtime.hold("open")
    const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository))
    yield* held.reached
    assert.deepStrictEqual(yield* inboxStatus(id), [{ status: "delivering" }])
    yield* held.release("failed")
    yield* until(
      sql<{ id: number }>`SELECT id FROM process WHERE session_id = ${id} AND ended_at IS NOT NULL`,
      (rows) => rows.length > 0,
    )
    assert.deepStrictEqual(yield* inboxStatus(id), [{ status: "dropped" }])
    assert.deepStrictEqual(
      yield* sql<{ accepted: number | null }>`SELECT accepted_at AS accepted FROM execution WHERE session_id = ${id}`,
      [{ accepted: null }],
    )
  }),
  { hooked: ["pi"] },
)

test(
  "a claimed batch whose write fails after the execution was closed is not delivered",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const runtime = yield* FakeRuntime
    const { db, sessions, id } = yield* idleSession(yield* makeRepository)
    const held = yield* runtime.hold("send", id)
    yield* sessions.send(id, "not handed")
    yield* held.reached
    const execution = yield* db.session.openExecution(id)
    yield* db.session.closeExecution(id, execution!, "interrupted")
    yield* held.release("failed")
    yield* until(inboxStatus(id, "not handed"), (rows) => rows[0]?.status !== "delivering")
    assert.notStrictEqual((yield* inboxStatus(id, "not handed"))[0]?.status, "delivered")
    assert.deepStrictEqual(
      yield* sql<{ accepted: number | null }>`SELECT accepted_at AS accepted FROM execution
        WHERE session_id = ${id} AND id = ${execution}`,
      [{ accepted: null }],
    )
  }),
  { hooked: ["pi"] },
)

test(
  "an unreachable hand-over stays unconfirmed and is not work the daemon is still doing",
  Effect.gen(function* () {
    const runtime = yield* FakeRuntime
    const drain = yield* Drain.Service
    const { sessions, id } = yield* idleSession(yield* makeRepository)
    const held = yield* runtime.hold("send", id)
    yield* sessions.send(id, "ambiguous")
    yield* held.reached
    yield* held.release("unreachable")
    yield* sessions.check(id)
    yield* TestClock.adjust("30 seconds")
    yield* sessions.check(id)
    assert.deepStrictEqual(yield* inboxStatus(id, "ambiguous"), [{ status: "delivering" }])
    assert.deepStrictEqual(yield* drain.pending, [])
  }),
  { hooked: ["pi"] },
)

test(
  "a refused message tells the session that sent it",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* Db.Service
    const inbox = yield* Inbox.Service
    const { id, entryId } = yield* idleSession(yield* makeRepository)
    const item = yield* db.inbox.insertSend(entryId, "from child", { type: "agent", session: id })
    yield* inbox.undelivered((yield* db.session.getSession(entryId))!, [item!], "definite refusal")
    assert.deepStrictEqual(
      yield* sql<{ sessionId: string }>`SELECT session_id AS sessionId FROM inbox
        WHERE sender_type = 'vibest' AND instr(content, 'definite refusal') > 0`,
      [{ sessionId: id }],
    )
  }),
  { hooked: ["pi"] },
)

test(
  "interrupting or archiving a session that has not launched ends its unsent message",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const sessions = yield* Session.Service
    const runtime = yield* FakeRuntime
    const input = yield* spawnInput(yield* makeRepository)
    yield* runtime.seedAgent("test/coord")
    yield* (yield* Concurrency.Service).configure([{ max: 1 }])
    const first = yield* sessions.spawn(input)
    const second = yield* sessions.spawn(input)
    yield* until((yield* Starts.Service).waiting, (keys) => keys.length === 2)
    yield* sessions.interrupt(first.id)
    yield* sessions.remove(second.id)

    assert.deepStrictEqual(
      yield* sql<{ status: string; processes: number }>`SELECT i.status AS status,
        (SELECT count(*) FROM process p WHERE p.session_id = i.session_id) AS processes
        FROM inbox i WHERE i.session_id = ${first.id}`,
      [{ status: "dropped", processes: 0 }],
    )

    const task = yield* sql<{ status: string }>`SELECT i.status AS status FROM inbox i
      JOIN session s ON s.id = i.session_id AND s.message_id = i.id WHERE s.id = ${second.id}`

    assert.deepStrictEqual(task, [{ status: "failed" }])
    assert.isFalse(
      (yield* sql<{ id: number }>`SELECT id FROM inbox
          WHERE session_id = ${second.id} AND status IN ('pending', 'delivering')`).length > 0,
    )
  }),
  { hooked: ["pi"] },
)

test(
  "the integration reporting that this execution's input started is what delivers a taken batch",
  Effect.gen(function* () {
    const db = yield* Db.Service
    const inbox = yield* Inbox.Service
    const integration = yield* Integration.Service
    const { entryId } = yield* idleSession(yield* makeRepository)
    yield* db.inbox.insertSend(entryId, "hello", { type: "user" })
    const taken = yield* inbox.take(entryId, undefined)
    assert.deepStrictEqual(yield* inboxStatus(entryId, "hello"), [{ status: "delivering" }])
    yield* integration.prompt(
      { id: entryId, entry: true, harness: "pulling-pi" },
      JSON.stringify({ type: "accepted", execution: taken!.execution }),
    )
    assert.deepStrictEqual(yield* inboxStatus(entryId, "hello"), [{ status: "delivered" }])
  }),
  { hooked: ["pi", "pulling-pi"] },
)
