import { assert, describe } from "@effect/vitest"
import { Harnesses } from "@vibest/core/harness"
import { Integration } from "@vibest/core/integration"
import { turnEndFrom } from "@vibest/core/results"
import { Clock, Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { answerOf, eventsOf, settled, until, writeResult } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { idleSession, spawnWorking, sqlNotices, test } from "./lib/sessions-helpers.ts"

const observedEnd = (harness: string, payload: object) =>
  Effect.gen(function* () {
    const adapter = yield* (yield* Harnesses).get(harness)
    return turnEndFrom(adapter, payload as Record<string, unknown>, yield* Clock.currentTimeMillis)
  })

const ends = (id: string) => eventsOf(id, "turn.ended").pipe(Effect.map((rows) => rows.map((row) => row.data)))

const pendingSends = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ content: string }>`SELECT content FROM inbox
      WHERE recipient_session_id = ${id} AND kind = 'send' AND status = 'pending'`.pipe(
      Effect.map((rows) => rows.map((row) => row.content)),
      Effect.orDie,
    )
  })

describe("observed turn end", () => {
  test(
    "an end closes the open turn with its reply; an end with no open turn is a turn of its own",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "first" })
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      yield* writeResult(id, "pi", { text: "second" })
      assert.deepStrictEqual(
        (yield* ends(id)).map((end) => [end.status, end.reply]),
        [
          ["completed", "first"],
          ["completed", "second"],
        ],
      )
      assert.strictEqual(yield* answerOf(id), "second")
      assert.isEmpty(yield* sqlNotices(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "an end is ignored for the entry session and for a harness the session no longer runs",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const [entry] = yield* sql<{ id: string }>`SELECT entry_session_id AS id FROM project`
      assert.isUndefined(yield* db.endObserved(entry!.id, yield* observedEnd("pi", { text: "x" })))
      assert.isUndefined(yield* db.endObserved(id, yield* observedEnd("claude", { last_assistant_message: "x" })))
      assert.deepStrictEqual(yield* ends(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupted end closes the open turn as interrupted and tells no one; with no open turn it writes nothing",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "", error: "aborted", aborted: true })
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
      yield* writeResult(id, "pi", { text: "", error: "aborted", aborted: true })
      assert.lengthOf(yield* ends(id), 1)
      assert.isEmpty(yield* sqlNotices(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "a failed end notifies once in the same write; a usage limit does not",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "", error: "model_error" })
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      const notices = yield* sqlNotices(id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0], "turn ended with an error: model_error")
      const other = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(other.id, "pi", { text: "", error: "rate_limit" })
      assert.strictEqual((yield* db.getSession(other.id))!.turnState, "failed")
      assert.isEmpty(yield* sqlNotices(other.id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "a close vibestd decided writes nothing when an observed end already closed that turn",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const turn = (yield* db.openTurn(id))!
      yield* writeResult(id, "pi", { text: "done" })
      assert.isFalse(yield* db.closeTurn(id, turn, "lost", { failure: "gone", notice: "lost it" }))
      assert.deepStrictEqual(
        (yield* ends(id)).map((end) => end.status),
        ["completed"],
      )
      assert.isEmpty(yield* sqlNotices(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "a hook end is written while check holds the session lock",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* (yield* Integration).turnEnd(
        { id, agent: "general", harness: "pi" },
        JSON.stringify({ type: "agent_settled", text: "done while locked" }),
      )
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.strictEqual(yield* answerOf(id), "done while locked")
      yield* held.release()
      yield* Fiber.join(checking)
      assert.lengthOf(yield* ends(id), 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "archive waits while a turn the user typed is open",
    Effect.gen(function* () {
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      yield* sessions.userPrompt(id, "typed")
      assert.isFalse(yield* db.archiveIfNoPending(id))
      yield* writeResult(id, "pi", { text: "done" })
      assert.isTrue(yield* db.archiveIfNoPending(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "a message waiting for the harness stays queued when the user opens a turn first, and goes in after it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("state", id, 1)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* writeResult(id, "pi", { text: "" })
      yield* sessions.userPrompt(id, "typed first")
      yield* held.release()
      yield* settled
      assert.notInclude(
        (yield* herdr.callsTo("send")).map((call) => call.text),
        "next",
      )
      assert.deepStrictEqual(yield* pendingSends(id), ["next"])
      yield* herdr.endTurn(id)
      yield* writeResult(id, "pi", { text: "typed done" })
      yield* sessions.check(id)
      yield* until(herdr.callsTo("send"), (calls) => calls.some((call) => call.text === "next"))
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupt that loses to the turn end reports the turn finished and keeps its reply",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* held.reached
      yield* writeResult(id, "pi", { text: "finished first" })
      yield* herdr.endTurn(id)
      yield* held.release()
      const result = yield* Fiber.join(interrupting)
      assert.include(result.message, "finished its turn before the interrupt took effect")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.strictEqual(yield* answerOf(id), "finished first")
    }),
    { hooked: ["pi"] },
  )
})
