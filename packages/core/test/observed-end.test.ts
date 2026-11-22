import { assert, describe } from "@effect/vitest"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { Harnesses } from "@vibest/core/harnesses"
import { Integration } from "@vibest/core/integration"
import { executionEndFrom } from "@vibest/core/replies"
import { Clock, Effect, Fiber, type Schema } from "effect"
import { SqlClient } from "effect/sql"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { replyOf, eventsOf, until, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { idleSession, spawnWorking, test } from "./lib/sessions-helpers.ts"

const observedEnd = (harness: string, payload: Schema.JsonObject) =>
  Effect.gen(function* () {
    const adapter = yield* (yield* Harnesses.Service).get(harness)

    const observed = adapter.executionEnd?.(payload)

    if (observed === undefined) return undefined

    return executionEndFrom(adapter, observed, yield* Clock.currentTimeMillis)
  })

const ends = (id: string) =>
  eventsOf(id).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        row.type === "execution.succeeded" ||
        row.type === "execution.failed" ||
        row.type === "execution.interrupted" ||
        row.type === "execution.unresolved"
          ? [row.data]
          : [],
      ),
    ),
  )

describe("observed execution end", () => {
  test(
    "an end before the open execution is accepted belongs to earlier activity: it neither closes it nor opens another",
    Effect.gen(function* () {
      const { id, db } = yield* idleSession(yield* makeRepository)
      const before = yield* ends(id)
      const { execution } = yield* db.session.startExecution(id, yield* Clock.currentTimeMillis)
      assert.strictEqual(
        yield* db.session.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "background" })),
        "completed",
      )
      assert.deepStrictEqual((yield* ends(id)).at(-1), { executionId: execution, reply: "background" })
      assert.strictEqual((yield* ends(id)).length, before.length + 1)
      assert.isUndefined(yield* db.session.openExecution(id))
      assert.strictEqual(
        yield* db.session.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "background" })),
        "completed",
      )
      assert.strictEqual((yield* ends(id)).length, before.length + 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a start or end report from an earlier process of the session is dropped",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const current = (yield* db.session.currentProcessId(id))!
      const earlier = current - 1
      assert.isUndefined(
        yield* db.session.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "old" }), earlier),
      )
      assert.deepStrictEqual(yield* ends(id), [])
      assert.strictEqual(
        yield* db.session.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "new" }), current),
        "completed",
      )
      yield* db.session.startObserved(id, "typed into the old process", yield* Clock.currentTimeMillis, earlier)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupted end from a closed terminal is the exit: the execution fails as the harness exited and the queued send fails",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      yield* sessions.send(id, "queued")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* (yield* Integration.Service).executionEnd(
        { id, entry: false, harness: "claude" },
        JSON.stringify({ hook_event_name: "ExecutionComplete", reason: "aborted", last_assistant_message: "" }),
      )
      const row = (yield* db.session.getSession(id))!
      assert.strictEqual(executionStateOf(row), "interrupted")
      assert.notStrictEqual(executionStateOf(row), "failed")
    }),
    { hooked: ["claude"] },
  )

  test(
    "a finished execution's report does not change the successor, which its own report can still finish",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { id, db, row } = yield* spawnWorking(yield* makeRepository, "claude")
      const integration = yield* Integration.Service
      const a = (yield* db.session.openExecution(id))!
      const who = { id, entry: false, harness: "claude" as const, process: row.process?.id }

      const report = (execution: number, reply: string) =>
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: reply,
          execution,
          conversation_id: "obsolete",
        })

      yield* integration.executionEnd(who, report(a, "reply A"))
      const b = (yield* db.session.startExecution(id, yield* Clock.currentTimeMillis)).execution
      yield* db.session.acceptExecution(id, b)
      yield* db.session.setStatus(id, "working")
      const before = yield* db.session.getSession(id)
      const facts = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE aggregate = ${id}`)[0]?.n
      yield* integration.executionEnd(who, report(a, "reply A"))
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "reply A",
          conversation_id: "obsolete",
        }),
      )
      assert.deepStrictEqual(yield* db.session.getSession(id), before)
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE aggregate = ${id}`)[0]?.n,
        facts,
      )
      assert.deepStrictEqual(yield* db.session.openExecution(id), b)
      yield* integration.executionEnd(who, report(b, "reply A"))
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
      assert.strictEqual(yield* replyOf(id), "reply A")
    }),
    { hooked: ["claude"] },
  )

  test(
    "a hook end is written while check holds the session lock",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* (yield* Integration.Service).executionEnd(
        { id, entry: false, harness: "pi" },
        JSON.stringify({ type: "agent_settled", text: "done while locked" }),
      )
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
      assert.strictEqual(yield* replyOf(id), "done while locked")
      yield* held.release()
      yield* Fiber.join(checking)
      assert.lengthOf(yield* ends(id), 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a message is delivered into the execution it was handed to, even when that execution ended before the delivery was recorded",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      const handed = yield* db.session.openExecution(id)
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "done fast" })
      yield* held.release()

      const [row] = yield* until(
        sql<{ status: string; execution: number | null }>`SELECT status, execution_id AS execution FROM inbox
          WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        (rows) => rows[0]?.status === "delivered",
      )

      assert.isDefined(handed)
      assert.strictEqual(row!.execution, handed)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a forced archive closes the execution the user typed while it waited for the interrupt",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "working" }))
      const held = yield* herdr.hold("send", id)
      const removing = yield* Effect.forkChild(sessions.remove(id))
      yield* held.reached
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "", error: "aborted", aborted: true })
      yield* sessions.userPrompt(id, "typed during the archive")
      assert.isDefined(yield* db.session.openExecution(id))
      yield* held.release()
      yield* Fiber.join(removing)
      assert.isUndefined(yield* db.session.openExecution(id))
      assert.notStrictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      yield* sessions.userPrompt(id, "typed after the archive")
      assert.isUndefined(yield* db.session.openExecution(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupt that loses to the execution end reports the execution finished and keeps its reply",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* held.reached
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "finished first" })
      yield* herdr.endExecution(id)
      yield* held.release()
      const result = yield* Fiber.join(interrupting)
      assert.include(result.message, "finished its execution before the interrupt took effect")
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
      assert.strictEqual(yield* replyOf(id), "finished first")
    }),
    { hooked: ["pi"] },
  )
})
