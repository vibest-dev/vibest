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

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { idleSession, spawnInput, test } from "./lib/sessions-helpers.ts"

const here = { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } }

const inboxStatus = (sessionId: string, content?: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    content === undefined
      ? sql<{ status: string }>`SELECT status FROM inbox WHERE recipient_session_id = ${sessionId} ORDER BY id`
      : sql<{
          status: string
        }>`SELECT status FROM inbox WHERE recipient_session_id = ${sessionId} AND content = ${content}`,
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
      yield* sql<{ started: number | null }>`SELECT started_at AS started FROM execution WHERE session_id = ${id}`,
      [{ started: null }],
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
      yield* sql<{ started: number | null }>`SELECT started_at AS started FROM execution
        WHERE session_id = ${id} AND id = ${execution}`,
      [{ started: null }],
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
      yield* sql<{ sessionId: string }>`SELECT recipient_session_id AS sessionId FROM inbox
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
    yield* sessions.archive(second.id)

    assert.deepStrictEqual(
      yield* sql<{ status: string; processes: number }>`SELECT i.status AS status,
        (SELECT count(*) FROM process p WHERE p.session_id = i.recipient_session_id) AS processes
        FROM inbox i WHERE i.recipient_session_id = ${first.id}`,
      [{ status: "dropped", processes: 0 }],
    )

    const task = yield* sql<{ status: string }>`SELECT i.status AS status FROM inbox i
      JOIN session s ON s.id = i.recipient_session_id AND s.message_id = i.id WHERE s.id = ${second.id}`

    assert.deepStrictEqual(task, [{ status: "dropped" }])
    assert.isFalse(
      (yield* sql<{ id: number }>`SELECT id FROM inbox
          WHERE recipient_session_id = ${second.id} AND status IN ('pending', 'delivering')`).length > 0,
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
      { id: entryId, harness: "pulling-pi" },
      JSON.stringify({ type: "accepted", execution: taken!.execution, ids: taken!.ids }),
    )
    assert.deepStrictEqual(yield* inboxStatus(entryId, "hello"), [{ status: "delivered" }])
  }),
  { hooked: ["pi", "pulling-pi"] },
)

test(
  "an unrelated prompt does not deliver a taken batch, and the batch report does",
  Effect.gen(function* () {
    const db = yield* Db.Service
    const inbox = yield* Inbox.Service
    const sessions = yield* Session.Service
    const integration = yield* Integration.Service
    const { entryId } = yield* idleSession(yield* makeRepository)
    yield* db.inbox.insertSend(entryId, "one", { type: "user" })
    yield* db.inbox.insertSend(entryId, "two", { type: "user" })
    const taken = yield* inbox.take(entryId, undefined)
    yield* sessions.userPrompt(entryId, "an unrelated typed question")
    assert.deepStrictEqual(yield* inboxStatus(entryId, "one"), [{ status: "delivering" }])
    assert.deepStrictEqual(yield* inboxStatus(entryId, "two"), [{ status: "delivering" }])
    yield* integration.prompt(
      { id: entryId, harness: "pulling-pi" },
      JSON.stringify({ type: "accepted", execution: taken!.execution, ids: taken!.ids }),
    )
    assert.deepStrictEqual(yield* inboxStatus(entryId, "one"), [{ status: "delivered" }])
    assert.deepStrictEqual(yield* inboxStatus(entryId, "two"), [{ status: "delivered" }])
  }),
  { hooked: ["pi", "pulling-pi"] },
)

test(
  "a terminal that is already working is not given the launch input",
  Effect.gen(function* () {
    const runtime = yield* FakeRuntime
    const db = yield* Db.Service
    const sessions = yield* Session.Service
    const repo = yield* makeRepository
    yield* runtime.seedAgent("test/coord")
    yield* runtime.updateAgent("test/coord", (agent) => ({ ...agent, status: "working" }))

    const started = yield* db.session.startRoot(yield* projectOf(repo), "pi", false, here, {
      agent: "general",
      firstInput: "bootstrap",
    })

    yield* sessions.check(started.sessionId)
    assert.deepStrictEqual(yield* runtime.callsTo("open"), [])
    assert.deepStrictEqual(yield* runtime.callsTo("send"), [])
    assert.notStrictEqual((yield* inboxStatus(started.sessionId))[0]?.status, "delivered")
  }),
  { hooked: ["pi"] },
)

test(
  "a text write with no pickup is not typed again",
  Effect.gen(function* () {
    const runtime = yield* FakeRuntime
    const { id, sessions } = yield* idleSession(yield* makeRepository)
    yield* runtime.updateAgent(id, (agent) => ({ ...agent, registerPrompt: false }))
    yield* sessions.send(id, "possible handoff")
    yield* until(runtime.callsTo("send"), (calls) => calls.some((call) => call.text === "possible handoff"))

    for (let i = 0; i < 4; i++) yield* TestClock.adjust("9 seconds")
    const texts = (yield* runtime.callsTo("send")).filter((call) => call.text === "possible handoff")
    assert.lengthOf(texts, 1)
    assert.deepStrictEqual(yield* inboxStatus(id, "possible handoff"), [{ status: "delivering" }])
  }),
  { hooked: ["pi"] },
)

test(
  "an unrelated prompt while a typed write is held does not deliver that batch",
  Effect.gen(function* () {
    const runtime = yield* FakeRuntime
    const { id, sessions } = yield* idleSession(yield* makeRepository)
    yield* runtime.updateAgent(id, (agent) => ({ ...agent, registerPrompt: false }))
    const held = yield* runtime.hold("send", id)
    yield* sessions.send(id, "bound batch")
    yield* held.reached
    yield* sessions.userPrompt(id, "an unrelated typed question")
    yield* runtime.updateAgent(id, (agent) => ({ ...agent, status: "working", seq: agent.seq + 1 }))
    yield* held.release()

    for (let i = 0; i < 4; i++) yield* TestClock.adjust("9 seconds")
    assert.deepStrictEqual(yield* inboxStatus(id, "bound batch"), [{ status: "delivering" }])
  }),
  { hooked: ["pi"] },
)

test(
  "a successful write after the execution was interrupted is not a handoff",
  Effect.gen(function* () {
    const runtime = yield* FakeRuntime
    const { db, id, sessions } = yield* idleSession(yield* makeRepository)
    yield* runtime.updateAgent(id, (agent) => ({ ...agent, registerPrompt: false }))
    const held = yield* runtime.hold("send", id)
    yield* sessions.send(id, "bound batch")
    yield* held.reached
    const execution = yield* db.session.openExecution(id)
    yield* db.session.closeExecution(id, execution!, "interrupted")
    yield* held.release()

    for (let i = 0; i < 2; i++) yield* TestClock.adjust("9 seconds")
    assert.deepStrictEqual(yield* inboxStatus(id, "bound batch"), [{ status: "delivering" }])
  }),
  { hooked: ["pi"] },
)

test(
  "archiving a completed subagent does not drop its initial delegation or notify its creator",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { id, entryId, sessions } = yield* idleSession(yield* makeRepository)
    assert.deepStrictEqual(yield* inboxStatus(id), [{ status: "delivered" }])
    yield* sessions.archive(id)

    const dropped = yield* sql<{ type: string }>`SELECT type FROM event
      WHERE aggregate = ${id} AND type = 'inbox.dropped'`

    assert.deepStrictEqual(dropped, [])

    const notices = yield* sql<{ content: string }>`SELECT content FROM inbox
      WHERE recipient_session_id = ${entryId} AND sender_type = 'vibest'
        AND instr(content, 'was not delivered: it was archived') > 0`

    assert.deepStrictEqual(notices, [])
  }),
  { hooked: ["pi"] },
)
