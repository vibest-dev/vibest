import { assert, describe } from "@effect/vitest"
import { exitedAt, executionStateOf } from "@vibest/core/database/rows"
import { Integration } from "@vibest/core/harness/integration"
import { Harnesses } from "@vibest/core/harness/registry"
import { Inbox } from "@vibest/core/inbox"
import { executionEndFrom } from "@vibest/core/session/replies"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { PULLING_CLAUDE } from "@vibest/testkit/harnesses"
import { replyOf, eventsOf, until, writeEnd, yieldToIo } from "@vibest/testkit/observe"
import { makeRepository } from "@vibest/testkit/session"
import { idleSession, spawnWorking, test } from "@vibest/testkit/sessions-helpers"
import { Clock, Effect, Fiber, type Schema } from "effect"
import { SqlClient } from "effect/sql"

const observedEnd = (harness: string, payload: Schema.JsonObject) =>
  Effect.gen(function* () {
    const adapter = yield* (yield* Harnesses.Service).get(harness)

    const observed = adapter.executionEnd?.(payload)

    if (observed === undefined) return yield* Effect.die("no observed end")

    return executionEndFrom(adapter, observed, yield* Clock.currentTimeMillis)
  })

const ends = (id: string) =>
  eventsOf(id).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        row.type === "session.execution.succeeded" ||
        row.type === "session.execution.failed" ||
        row.type === "session.execution.interrupted" ||
        row.type === "session.execution.unresolved"
          ? [row.data]
          : [],
      ),
    ),
  )

describe("observed execution end", () => {
  test(
    "an end before the open execution is accepted belongs to earlier activity: it neither closes it nor opens another",
    Effect.gen(function* () {
      const { id, sessionStore } = yield* idleSession(yield* makeRepository)
      const before = yield* ends(id)
      const { execution } = yield* sessionStore.startExecution(id, yield* Clock.currentTimeMillis)
      assert.isUndefined(
        yield* sessionStore.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "background" })),
      )
      assert.deepStrictEqual(yield* ends(id), before)
      assert.strictEqual(yield* sessionStore.openExecution(id), execution)
      yield* sessionStore.acceptExecution(id, execution)
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "mine" })
      assert.deepStrictEqual((yield* ends(id)).at(-1), { sessionId: id, executionId: execution, reply: "mine" })
    }),
    { hooked: ["pi"] },
  )

  test(
    "a start or end report from an earlier process of the session is dropped",
    Effect.gen(function* () {
      const { id, sessionStore } = yield* spawnWorking(yield* makeRepository)
      const current = (yield* sessionStore.currentProcessId(id))!
      const earlier = current - 1
      assert.isUndefined(
        yield* sessionStore.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "old" }), earlier),
      )
      assert.deepStrictEqual(yield* ends(id), [])
      assert.strictEqual(
        yield* sessionStore.endObserved(id, yield* observedEnd("pi", { type: "agent_settled", text: "new" }), current),
        "completed",
      )
      yield* sessionStore.startObserved(id, "typed into the old process", yield* Clock.currentTimeMillis, earlier)
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "completed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupted end from a closed terminal is the exit: the execution fails as the harness exited and the queued send fails",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, sessionStore, inboxStore } = yield* spawnWorking(yield* makeRepository, "claude")
      yield* sessions.send(id, "queued")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* (yield* Integration.Service).executionEnd(
        { id, harness: "claude" },
        JSON.stringify({ hook_event_name: "ExecutionComplete", reason: "aborted", last_assistant_message: "" }),
      )
      const row = (yield* sessionStore.getSession(id))!
      assert.strictEqual(executionStateOf(row), "failed")
      assert.isNotNull(exitedAt(row))
      assert.deepStrictEqual(
        (yield* inboxStore.inboxWithStatus(id, "failed")).map((r) => r.message),
        ["queued"],
      )
    }),
    { hooked: ["claude"] },
  )

  test(
    "an unkeyed end between inbox take and PromptSubmit does not settle the unaccepted pulled execution",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const inbox = yield* Inbox.Service
      const integration = yield* Integration.Service
      const { id, sessionStore, inboxStore, row } = yield* spawnWorking(yield* makeRepository, "pulling-claude")
      const who = { id, harness: "pulling-claude" as const, process: row.process?.id }
      const first = (yield* sessionStore.openExecution(id))!
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "Turn 1 answer",
          execution: first,
        }),
      )
      yield* inboxStore.insertSend(id, "Turn 2 question")
      const taken = (yield* inbox.take(id, row.process?.id))!
      assert.strictEqual(taken.execution, first + 1)
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "Late unkeyed background note",
        }),
      )
      assert.strictEqual(yield* sessionStore.openExecution(id), taken.execution)
      yield* integration.prompt(
        who,
        JSON.stringify({
          hook_event_name: "PromptSubmit",
          origin: "vibest",
          execution: taken.execution,
          ids: taken.ids,
        }),
      )
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "Real Turn 2 answer",
          execution: taken.execution,
        }),
      )
      assert.strictEqual(yield* replyOf(id), "Real Turn 2 answer")

      const [delivered] = yield* sql<{ status: string }>`SELECT status FROM inbox
        WHERE recipient_session_id = ${id} AND content = 'Turn 2 question'`

      assert.strictEqual(delivered?.status, "delivered")
    }),
    { hooked: ["pi", "pulling-claude"], harnesses: [PULLING_CLAUDE] },
  )

  test(
    "a refused pulled batch that falls back to typed input settles on its unkeyed interrupted end",
    Effect.gen(function* () {
      const inbox = yield* Inbox.Service
      const integration = yield* Integration.Service
      const { id, sessionStore, inboxStore, row } = yield* spawnWorking(yield* makeRepository, "pulling-claude")
      const who = { id, harness: "pulling-claude" as const, process: row.process?.id }
      const first = (yield* sessionStore.openExecution(id))!
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "Turn 1 answer",
          execution: first,
        }),
      )
      yield* inboxStore.insertSend(id, "Hold until stopped")
      const taken = (yield* inbox.take(id, row.process?.id))!
      yield* integration.prompt(
        who,
        JSON.stringify({
          hook_event_name: "PromptSubmit",
          origin: "composer",
          text: "Hold until stopped",
        }),
      )
      yield* integration.executionEnd(
        who,
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "aborted",
          last_assistant_message: "",
        }),
      )
      assert.isUndefined(yield* sessionStore.openExecution(id))
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "interrupted")
      assert.strictEqual(yield* replyOf(id), "")
      assert.strictEqual(taken.execution, first + 1)
    }),
    { hooked: ["pi", "pulling-claude"], harnesses: [PULLING_CLAUDE] },
  )

  test(
    "a finished execution's report does not change the successor, which its own report can still finish",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { id, sessionStore, row } = yield* spawnWorking(yield* makeRepository, "claude")
      const integration = yield* Integration.Service
      const a = (yield* sessionStore.openExecution(id))!
      const who = { id, harness: "claude" as const, process: row.process?.id }

      const report = (execution: number, reply: string) =>
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: reply,
          execution,
          conversation_id: "obsolete",
        })

      yield* integration.executionEnd(who, report(a, "reply A"))
      const b = (yield* sessionStore.startExecution(id, yield* Clock.currentTimeMillis)).execution
      yield* sessionStore.acceptExecution(id, b)
      yield* sessionStore.setStatus(id, "working")
      const before = yield* sessionStore.getSession(id)
      const facts = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${id}`)[0]?.n
      yield* integration.executionEnd(who, report(a, "reply A"))
      yield* integration.executionEnd(
        { ...who, process: who.process! - 1 },
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "reply A",
          conversation_id: "obsolete",
        }),
      )
      assert.deepStrictEqual(yield* sessionStore.getSession(id), before)
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${id}`)[0]?.n,
        facts,
      )
      assert.deepStrictEqual(yield* sessionStore.openExecution(id), b)
      yield* integration.executionEnd(who, report(b, "reply A"))
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "completed")
      assert.strictEqual(yield* replyOf(id), "reply A")
    }),
    { hooked: ["claude"] },
  )

  test(
    "a hook end is written while check holds the session lock",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, sessionStore } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      const execution = (yield* sessionStore.openExecution(id))!
      yield* (yield* Integration.Service).executionEnd(
        { id, harness: "pi" },
        JSON.stringify({ type: "agent_settled", text: "done while locked", execution }),
      )
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "completed")
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
      const { id, sessions, sessionStore } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      const handed = yield* sessionStore.openExecution(id)
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "done fast" })
      yield* held.release()

      const [row] = yield* until(
        sql<{ status: string; execution: number | null }>`SELECT status, recipient_execution_id AS execution FROM inbox
          WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
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
      const { id, sessions, sessionStore } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "working" }))
      const held = yield* herdr.hold("send", id)
      const removing = yield* Effect.forkChild(sessions.archive(id))
      yield* held.reached
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "", error: "aborted", aborted: true })
      yield* sessions.userPrompt(id, "typed during the archive")
      assert.isDefined(yield* sessionStore.openExecution(id))
      yield* held.release()
      yield* Fiber.join(removing)
      assert.isUndefined(yield* sessionStore.openExecution(id))
      assert.notStrictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "open")
      yield* sessions.userPrompt(id, "typed after the archive")
      assert.isUndefined(yield* sessionStore.openExecution(id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupt that loses to the execution end reports the execution finished and keeps its reply",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, sessionStore } = yield* spawnWorking(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* held.reached
      yield* writeEnd(id, "pi", { type: "agent_settled", text: "finished first" })
      yield* herdr.endExecution(id)
      yield* held.release()
      const result = yield* Fiber.join(interrupting)
      assert.include(result.message, "finished its execution before the interrupt took effect")
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "completed")
      assert.strictEqual(yield* replyOf(id), "finished first")
    }),
    { hooked: ["pi"] },
  )

  test(
    "an interrupt whose runtime goes idle before the integration's aborted end arrives waits for and confirms the interrupt",
    Effect.gen(function* () {
      const { id, sessions, sessionStore } = yield* spawnWorking(yield* makeRepository)
      const execution = (yield* sessionStore.openExecution(id))!
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* yieldToIo
      assert.isUndefined(interrupting.pollUnsafe())
      yield* (yield* Integration.Service).executionEnd(
        { id, harness: "pi" },
        JSON.stringify({ type: "agent_settled", text: "", error: "aborted", aborted: true, execution }),
      )
      const result = yield* Fiber.join(interrupting)
      assert.strictEqual(result.message, `${id} interrupted; its terminal, worktree and session are kept`)
      assert.strictEqual(executionStateOf((yield* sessionStore.getSession(id))!), "interrupted")
    }),
    { hooked: ["pi"] },
  )
})
