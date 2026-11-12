import { assert, describe } from "@effect/vitest"
import { Harnesses } from "@vibest/core/harness"
import { Integration } from "@vibest/core/integration"
import { executionEndFrom } from "@vibest/core/replies"
import { Clock, Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { replyOf, eventsOf, until, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { idleSession, spawnWorking, sqlNotices, test } from "./lib/sessions-helpers.ts"

const observedEnd = (harness: string, payload: object) =>
  Effect.gen(function* () {
    const adapter = yield* (yield* Harnesses).get(harness)
    return executionEndFrom(adapter, payload as Record<string, unknown>, yield* Clock.currentTimeMillis)
  })

const ends = (id: string) => eventsOf(id, "execution.ended").pipe(Effect.map((rows) => rows.map((row) => row.data)))

describe("observed execution end", () => {
  test(
    "an end before the open execution is accepted belongs to earlier activity: it neither closes it nor opens another",
    Effect.gen(function* () {
      const { id, db } = yield* idleSession(yield* makeRepository)
      const before = yield* ends(id)
      const { execution } = yield* db.startExecution(id, yield* Clock.currentTimeMillis)
      assert.strictEqual(yield* db.endObserved(id, yield* observedEnd("pi", { text: "background" })), "unaccepted")
      assert.deepStrictEqual(yield* ends(id), before)
      assert.strictEqual(yield* db.openExecution(id), execution)
      yield* db.acceptExecution(id, execution)
      yield* writeEnd(id, "pi", { text: "mine" })
      assert.deepStrictEqual((yield* ends(id)).at(-1), { execution, outcome: "completed", reply: "mine" })
    }),
    { hooked: ["pi"] },
  )

  test(
    "a start or end report from an earlier process of the session is dropped",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const current = (yield* db.currentProcessId(id))!
      const earlier = current - 1
      assert.isUndefined(yield* db.endObserved(id, yield* observedEnd("pi", { text: "old" }), earlier))
      assert.deepStrictEqual(yield* ends(id), [])
      assert.strictEqual(yield* db.endObserved(id, yield* observedEnd("pi", { text: "new" }), current), "completed")
      yield* db.startObserved(id, "typed into the old process", yield* Clock.currentTimeMillis, earlier)
      assert.strictEqual((yield* db.getSession(id))!.executionState, "completed")
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
      yield* (yield* Integration).executionEnd(
        { id, entry: false, harness: "claude" },
        JSON.stringify({ hook_event_name: "ExecutionComplete", reason: "aborted", last_assistant_message: "" }),
      )
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.executionState, "failed")
      assert.isNotNull(row.exitedAt)
      assert.deepStrictEqual(
        (yield* db.inboxWithStatus(id, "failed")).map((r) => r.message),
        ["queued"],
      )
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
      yield* (yield* Integration).executionEnd(
        { id, entry: false, harness: "pi" },
        JSON.stringify({ type: "agent_settled", text: "done while locked" }),
      )
      assert.strictEqual((yield* db.getSession(id))!.executionState, "completed")
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
      const handed = yield* db.openExecution(id)
      yield* writeEnd(id, "pi", { text: "done fast" })
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
    "a usage limit is not moved when an execution the user typed opened while check looked at the runtime",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "", error: "rate_limit" })
      yield* herdr.endExecution(id)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* sessions.userPrompt(id, "typed during the check")
      const typed = yield* db.openExecution(id)
      yield* held.release()
      yield* Fiber.join(checking)
      assert.isDefined(typed)
      assert.strictEqual(yield* db.openExecution(id), typed)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "pi")
      assert.lengthOf(yield* herdr.callsTo("open"), 1)
      assert.isEmpty(yield* sqlNotices(id))
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
      yield* writeEnd(id, "pi", { text: "", error: "aborted", aborted: true })
      yield* sessions.userPrompt(id, "typed during the archive")
      assert.isDefined(yield* db.openExecution(id))
      yield* held.release()
      yield* Fiber.join(removing)
      assert.isUndefined(yield* db.openExecution(id))
      assert.notStrictEqual((yield* db.getSession(id))!.executionState, "open")
      yield* sessions.userPrompt(id, "typed after the archive")
      assert.isUndefined(yield* db.openExecution(id))
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
      yield* writeEnd(id, "pi", { text: "finished first" })
      yield* herdr.endExecution(id)
      yield* held.release()
      const result = yield* Fiber.join(interrupting)
      assert.include(result.message, "finished its execution before the interrupt took effect")
      assert.strictEqual((yield* db.getSession(id))!.executionState, "completed")
      assert.strictEqual(yield* replyOf(id), "finished first")
    }),
    { hooked: ["pi"] },
  )
})
