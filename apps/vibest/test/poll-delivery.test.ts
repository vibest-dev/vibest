// A subagent whose harness integration takes its rows itself (Claude, Pi: `delivery: "poll"`): nothing is typed into
// its terminal. Its integration polls `/inbox/poll`; the poll opens the round; the turn start that names the rows is the
// proof they were taken; a lease that runs out with none taken gives them back. Its turns are what its integration
// reports: the runtime's idle is no turn end, and an interrupt waits for the interrupted turn end.
import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { LEASE } from "@vibest/core/inbox"
import { Sessions } from "@vibest/core/sessions"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import * as Http from "@vibest/server/http"
import { repositoryKey } from "@vibest/vibest/worktree"
import { Duration, Effect, type Scope } from "effect"
import * as Headers from "effect/http/Headers"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime, makeRepository, testLayer, type TestServices, until, writeResult } from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ integrationPolls: false }))), 30_000)

/** A Claude subagent started and up, its integration (this test) not yet asking for anything. */
const started = Effect.gen(function* () {
  const db = yield* Db
  const sessions = yield* Sessions
  const repo = yield* makeRepository
  const key = yield* repositoryKey(repo)
  const main = yield* db.coordinatorLaunch(key, "claude", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: "test/coord" },
  })
  const { id } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    key,
    name: "t",
    prompt: "do it",
    harness: "claude",
  })
  yield* until(db.getSession(id), (w) => !!w && w.startedAt !== null)
  yield* sessions.check(id)
  const handle = yield* Http.make
  const call = (path: string, body: unknown) =>
    handle({
      path,
      headers: Headers.fromInput(
        sessionHeaders({ sessionId: id, projectId: String(main.projectId), harness: "claude" }),
      ),
      body: JSON.stringify(body),
    })
  return { db, sessions, id, call }
})

const statuses = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ content: string; status: string }>`SELECT content, status FROM inbox
      WHERE recipient_session_id = ${id} ORDER BY id`.pipe(Effect.orDie)
  })

test(
  "the task waits for the integration; its poll opens the round, and the turn start naming the row delivers it into that turn",
  Effect.gen(function* () {
    const { db, id, call } = yield* started
    const herdr = yield* FakeRuntime
    // Nothing typed: the task row waits, no round is open.
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "pending" }])
    assert.strictEqual((yield* db.getSession(id))!.turnState, "none")
    assert.deepStrictEqual(
      (yield* herdr.callsTo("send")).filter((c) => c.text !== undefined),
      [],
    )
    const polled = yield* call("/inbox/poll", {})
    const batch = polled.body as { ids: Array<number>; line: string; text: string }
    // A subagent's line is its rows' own text: the model follows the prompt.
    assert.deepInclude(batch, { line: "do it", text: "do it" })
    assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "delivering" }])
    // A second poll while the round is open hands out nothing.
    assert.deepStrictEqual(((yield* call("/inbox/poll", {})).body as { ids: Array<number> }).ids, [])
    const start = yield* call("/events", { type: "turn.start", origin: "inbox", text: "do it", inbox: batch.ids })
    assert.strictEqual(start.status, 204)
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "delivered" }])
    // Bound to the open turn: its result goes where that row came from.
    assert.isTrue(yield* db.turnTaken(id))
    // Another session's row id names nothing of this one's.
    assert.strictEqual(
      (yield* call("/events", { type: "turn.start", origin: "inbox", text: "x", inbox: [9999] })).status,
      204,
    )
  }),
)

test(
  "a lease that runs out with nothing taken puts the rows back and closes the round as not started; given back, the same",
  Effect.gen(function* () {
    const { db, sessions, id, call } = yield* started
    yield* call("/inbox/poll", {})
    yield* TestClock.adjust(Duration.sum(LEASE, Duration.seconds(1)))
    yield* sessions.check(id)
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "pending" }])
    assert.strictEqual((yield* db.getSession(id))!.turnState, "not_started")
    // Polled again and given back at once (the plugin could not submit it).
    const again = (yield* call("/inbox/poll", {})).body as { ids: Array<number> }
    assert.lengthOf(again.ids, 1)
    yield* call("/inbox/ack", { ids: [], release: again.ids })
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "pending" }])
    assert.strictEqual((yield* db.getSession(id))!.turnState, "not_started")
    // Taken late, by ack: the round opens again on it.
    const third = (yield* call("/inbox/poll", {})).body as { ids: Array<number> }
    yield* call("/inbox/ack", { ids: third.ids })
    assert.deepStrictEqual(yield* statuses(id), [{ content: "do it", status: "delivered" }])
    assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
  }),
)

test(
  "its turns are its integration's: the runtime reading idle mid-turn is no lost turn; the reported end is the result",
  Effect.gen(function* () {
    const { db, sessions, id, call } = yield* started
    const herdr = yield* FakeRuntime
    const batch = (yield* call("/inbox/poll", {})).body as { ids: Array<number> }
    yield* call("/events", { type: "turn.start", origin: "inbox", text: "do it", inbox: batch.ids })
    yield* herdr.endTurn(id)
    for (let i = 0; i < 3; i++) {
      yield* TestClock.adjust("20 seconds")
      yield* sessions.check(id)
    }
    assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    yield* writeResult(id, "claude", { text: "done" })
    yield* sessions.check(id)
    assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
  }),
)

test(
  "an interrupt waits for the interrupted turn end its integration reports, not for the runtime's idle",
  Effect.gen(function* () {
    const { db, sessions, id, call } = yield* started
    const herdr = yield* FakeRuntime
    const batch = (yield* call("/inbox/poll", {})).body as { ids: Array<number> }
    yield* call("/events", { type: "turn.start", origin: "inbox", text: "do it", inbox: batch.ids })
    // The runtime already reads idle (its state is no proof either way); the Esc's turn end comes from the integration.
    yield* herdr.updateAgent(id, (a) => ({ ...a, status: "working" }))
    assert.include((yield* sessions.interrupt(id)).message, "interrupted")
    assert.deepStrictEqual((yield* herdr.callsTo("send")).at(-1)!.keys, ["esc"])
    assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
    // Not working: nothing to interrupt.
    assert.include((yield* sessions.interrupt(id)).message, "not working")
  }),
)
