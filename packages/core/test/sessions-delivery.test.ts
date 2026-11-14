import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt } from "@vibest/core/database/db-rows"
import { Harnesses } from "@vibest/core/harnesses"
import { Integration } from "@vibest/core/integration"
import { unwrapped } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import { Clock, Effect, Exit, Fiber, Ref, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { entryPending, projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { CURSOR, PI } from "./lib/harnesses.ts"
import { replyOf, settled, EXECUTIONS, until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, spawnWorking, idleSession, test, pick, sqlNotices } from "./lib/sessions-helpers.ts"

describe.concurrent("Session", () => {
  test(
    "send while an execution runs is queued, then delivered merged once the session is idle",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.send(id, "one")
      yield* sessions.send(id, "two")
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "one\n\ntwo")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "open")
      const sql = yield* SqlClient.SqlClient
      const [execution] = yield* sql<{
        input: string
        inbox: number
      }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`
      const sent = yield* sql<{
        id: number
      }>`SELECT id FROM inbox WHERE session_id = ${id} AND content IN ('one', 'two') ORDER BY id`
      assert.strictEqual(execution!.input, "one\n\ntwo")
      assert.strictEqual(execution!.inbox, sent[1]!.id)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a prompt typed while a send waits for ready is its own execution; the send waits for it to end",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const first = yield* herdr.hold("state", id)
      const sending = yield* Effect.forkChild(sessions.send(id, "queued text"))
      yield* first.reached
      const second = yield* herdr.hold("state", id)
      yield* first.release()
      yield* second.reached
      assert.notStrictEqual(executionStateOf((yield* (yield* Db).getSession(id))!), "open")
      yield* sessions.userPrompt(id, "typed during the ready wait")
      const working = sql<{
        input: string
      }>`SELECT input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
        Effect.orDie,
      )
      assert.deepStrictEqual(
        (yield* working).map((row) => row.input),
        ["typed during the ready wait"],
      )
      yield* second.release()
      yield* Fiber.join(sending)
      assert.isFalse((yield* herdr.callsTo("send")).some((call) => call.text === "queued text"))
      yield* writeEnd(id, "pi", { text: "done" })
      yield* herdr.endExecution(id)
      yield* until(working, (rows) => rows[0]?.input === "queued text")
    }),
    { hooked: ["pi"] },
  )

  const typedBeforeTheTask = Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const sessions = yield* Session.Service
    const db = yield* Db
    const repo = yield* makeRepository
    const held = yield* herdr.hold("state")
    const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), archive: true })
    yield* held.reached
    yield* sessions.userPrompt(id, "typed during the ready wait")
    yield* held.release()
    yield* settled
    yield* herdr.endExecution(id)
    yield* writeEnd(id, "pi", { text: "typed done" })
    yield* until(
      herdr.callsTo("send").pipe(Effect.map((calls) => calls.some((c) => c.text?.includes("do it")))),
      (sent) => sent,
    )
    assert.isUndefined(yield* db.untakenTask(id))
    assert.isNull((yield* db.getSession(id))!.endedAt)
  })

  test(
    "auto-archive with runtime status events: the first task is still handed over after a typed execution ends",
    typedBeforeTheTask,
    { hooked: ["pi"], statusEvents: true },
  )

  test(
    "a prompt typed while the first task waits for ready is its own execution; the task is handed over once it ends",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const held = yield* herdr.hold("state")
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* held.reached
      yield* sessions.userPrompt(id, "typed during the ready wait")
      yield* held.release()
      const taskSent = herdr.callsTo("send").pipe(Effect.map((calls) => calls.some((c) => c.text?.includes("do it"))))
      yield* settled
      assert.isFalse(yield* taskSent)
      yield* writeEnd(id, "pi", { text: "typed done" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* until(taskSent, (sent) => sent)
      const linked = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE session_id = ${id} AND kind = 'task' AND execution_id IS NOT NULL`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(linked[0]!.n, 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "an echo during the runtime prompt returns without waiting and is not an execution",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* sessions.userPrompt(id, "echo of the paste")
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(
          Effect.orDie,
        ),
        [],
      )
      yield* held.release()
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(
          Effect.orDie,
        ),
        [],
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a typed prompt during check is recorded at once, without waiting for the lock check holds",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* sessions.userPrompt(id, "step in")
      assert.deepStrictEqual(
        yield* sql<{
          input: string
          status: string
        }>`SELECT input, status FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
          Effect.orDie,
        ),
        [{ input: "step in", status: "working" }],
      )
      yield* held.release()
      yield* Fiber.join(checking)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a reply after a late start report while confirm gives up is delivered, and the batch stays delivered",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* Session.Service
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* untilVirtual(db.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "not_started")
      yield* sessions.send(id, "next")
      yield* until(db.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* sessions.userPrompt(id, "next")
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: landed" }, 120_000)
      yield* untilVirtual(db.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      yield* untilVirtual(
        sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        (rows) => rows[0]?.status === "delivered",
      )
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "completed")
      assert.include(yield* replyOf(id), "landed")
      assert.strictEqual((yield* sqlNotices(id)).filter((message) => message.includes("task_not_started")).length, 1)
    }),
    { promptsIgnored: true, hooked: ["pi"] },
  )

  test(
    "a reply after a start report before a refused prompt is delivered, and the batch stays delivered",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* sessions.userPrompt(id, "next")
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: landed" }, 5_000)
      yield* held.release("busy")
      const done = yield* until(
        db.getSession(id),
        (w): w is NonNullable<typeof w> => (w ? executionStateOf(w) : undefined) === "completed",
      )
      assert.strictEqual(executionStateOf(done), "completed")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        [{ status: "delivered" }],
      )
      assert.include(yield* replyOf(id), "landed")
      assert.isUndefined(
        (yield* sqlNotices(id)).find(
          (message) => message.includes("task_not_started") || message.includes("send: busy"),
        ),
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a refused prompt with no result file still closes the execution and fails the batch",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* held.release("busy")
      const done = yield* until(
        db.getSession(id),
        (w): w is NonNullable<typeof w> => (w ? executionStateOf(w) : undefined) === "not_started",
      )
      assert.strictEqual(executionStateOf(done), "not_started")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        [{ status: "failed" }],
      )
      assert.include((yield* sqlNotices(id)).at(-1)!, "send: busy")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a refused prompt fails only that message and tells the owner; one accepted during it is not failed with it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const sql = yield* SqlClient.SqlClient
      const all = (receiverId: string) =>
        sql<{
          id: number
          status: string
        }>`SELECT id, status AS status FROM inbox WHERE session_id = ${receiverId} AND kind IN ('task', 'send') AND id > (SELECT min(id) FROM inbox WHERE session_id = ${receiverId} AND kind IN ('task', 'send')) ORDER BY id`.pipe(
          Effect.orDie,
        )

      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      const [first, second] = (yield* all(id)).map((r) => r.id)
      assert.deepStrictEqual(
        (yield* all(id)).map((r) => r.status),
        ["delivering", "pending"],
      )
      yield* held.release("failed")
      const notices = yield* until(sqlNotices(id), (rows) => rows.some((message) => message.includes("send: failed")))
      assert.match(notices.at(-1)!, new RegExp(`^A message to ${id} was not delivered: .*send: failed`))
      assert.match(notices.at(-1)!, /\n\nfirst$/)
      assert.notMatch(notices.at(-1)!, /second/)
      const rows = yield* until(all(id), (list) => list[1]?.status === "delivered")
      assert.deepStrictEqual(
        rows.map((row) => [row.id, row.status]),
        [
          [first, "failed"],
          [second, "delivered"],
        ],
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).map((call) => unwrapped(call.text!)),
        ["do it", "first", "second"],
      )
      assert.deepStrictEqual(pick(yield* db.getSession(id)), { status: "working", executionState: "open" })
    }),
    { hooked: ["pi"] },
  )

  test(
    "the connection breaks after the hand-over: possibly delivered, not sent again, and the execution the session never started closes",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const notices = sqlNotices(id)

      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release("unreachable")
      yield* until(notices, (rows) => rows.length === 1)
      assert.match(
        (yield* notices)[0]!,
        /^A message to .* was not delivered: the connection to herdr broke after the message was handed over.*it may have reached the session\n\nfirst$/s,
      )
      yield* sessions.check(id)
      assert.deepStrictEqual(pick(yield* db.getSession(id)), { status: "idle", executionState: "open" })
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["second"],
      )
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust("10 seconds")
        yield* sessions.check(id)
      }
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).map((c) => unwrapped(c.text!)),
        ["do it", "first", "second"],
      )
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.deepStrictEqual((yield* notices).slice(1), [
        `task_not_started: vibest did not see ${id} start the execution it was sent (if it starts it late, that execution's reply is not collected); it is idle and takes queued messages again.`,
      ])
    }),
    { hooked: ["pi"] },
  )

  test(
    "Cursor: herdr reports no session id, so the execution end's conversation id is kept and the session resumes with it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      assert.isNull((yield* db.getSession(id))!.process?.conversation ?? null)
      yield* writeEnd(id, "cursor", {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c-123",
        text: "status: completed",
      })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.process?.conversation ?? null, "c-123")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* until(db.getSession(id), (row) => (row ? exitedAt(row) : undefined) != null)
      const starts = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "next")
      const calls = yield* until(herdr.callsTo("open"), (c) => c.length > starts)
      assert.deepStrictEqual(calls.at(-1)!.argv.slice(0, 2), ["cursor-agent", "--resume=c-123"])
      yield* writeEnd(id, "cursor", { conversation_id: "c-other", text: "status: completed" }, 5000)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.process?.conversation ?? null, "c-other")
      yield* herdr.updateAgent(id, (a) => ({ ...a, session: "h-9" }))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.process?.conversation ?? null, "h-9")
    }),
  )

  test(
    "Cursor: a hook from an earlier process does not record its conversation id",
    Effect.gen(function* () {
      const integration = yield* Integration.Service
      const { id, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      const current = (yield* db.currentProcessId(id))!
      const event = JSON.stringify({ hook_event_name: "beforeSubmitPrompt", conversation_id: "c-old", prompt: "x" })
      yield* integration.prompt({ id, entry: false, harness: "cursor", process: current - 1 }, event)
      assert.isNull((yield* db.getSession(id))!.process?.conversation ?? null)
      yield* integration.prompt({ id, entry: false, harness: "cursor", process: current }, event)
      assert.strictEqual((yield* db.getSession(id))!.process?.conversation ?? null, "c-old")
    }),
  )

  test(
    "Cursor on a runtime with no status for it: the task waits for its ready report and, typed, shows it working without a resend; its execution end shows it idle, and an interrupt goes by its open execution",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db
      const repo = yield* makeRepository
      yield* Ref.set(herdr.onStarted, (session) =>
        herdr.updateAgent(session, (a) => ({ ...a, status: "unknown", registerPrompt: false })),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo, "cursor"))
      yield* until(db.getSession(id), (w) => !!w && (w.process?.placedAt ?? null) !== null)
      for (let i = 0; i < 20; i++) yield* untilVirtual(Effect.succeed(0), () => true)
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      yield* db.patchLive(id, { ready: yield* Clock.currentTimeMillis })
      yield* untilVirtual(db.getSession(id), (w) => w?.status === "working")
      assert.isTrue((yield* herdr.callsTo("send")).some((c) => c.text?.includes("do it")))
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "open")
      yield* TestClock.adjust("40 seconds")
      yield* settled
      assert.isFalse((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("enter")))
      const integration = yield* Integration.Service
      const who = { id, entry: false, harness: CURSOR.id }
      yield* integration.executionEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }))
      const thought = JSON.stringify({ hook_event_name: "afterAgentThought" })
      yield* integration.prompt(who, thought)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      yield* untilVirtual(db.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      yield* integration.prompt(who, thought)
      yield* settled
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      yield* sessions.send(id, "next")
      yield* untilVirtual(
        db.getSession(id),
        (w) => w !== undefined && executionStateOf(w) === "open" && w.status === "working",
      )
      const stopped = yield* sessions.interrupt(id)
      assert.include(stopped.message, "interrupted")
      assert.isTrue((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("ctrl+c")))
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.status, "idle")
      assert.strictEqual(executionStateOf(row), "interrupted")
    }),
  )

  test(
    "a send to a session whose harness no plugin provides any more fails with HarnessUnavailable in its notice",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const harnesses = yield* Harnesses.Service
      const loaded = yield* Scope.make()
      yield* harnesses.transform((editor) => editor.add({ ...PI, id: "leaving-pi" })).pipe(Scope.provide(loaded))
      const { id, sessions } = yield* spawnWorking(yield* makeRepository, "leaving-pi")
      yield* writeEnd(id, "leaving-pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* Scope.close(loaded, Exit.void)
      assert.strictEqual((yield* Effect.flip(harnesses.get("leaving-pi")))._tag, "HarnessUnavailable")
      yield* sessions.send(id, "hello")
      const [notice] = yield* until(sqlNotices(id), (rows) => rows.length === 1)
      assert.match(
        notice!,
        new RegExp(`^A message to ${id} was not delivered: no plugin provides harness leaving-pi; loaded: `),
      )
      assert.strictEqual(notice!.split("\n\n").at(-1), "hello")
      yield* sessions.check(id)
    }),
    { hooked: ["leaving-pi"] },
  )

  test(
    "a session that cannot be resumed: each accepted message fails on its own, with its own notice",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      yield* writeEnd(id, "cursor", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* settled
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release()
      const undeliveredNotices = Effect.map(sqlNotices(id), (rows) =>
        rows.filter((message) => message.includes("was not delivered")),
      )
      const notices = yield* until(undeliveredNotices, (rows) => rows.length === 2)
      assert.deepStrictEqual(
        notices.map((message) => message.split("\n\n").at(-1)),
        ["first", "second"],
      )
      for (const message of notices)
        assert.include(
          message,
          `A message to ${id} was not delivered: ${id} exited before the runtime reported its session id`,
        )
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
    }),
  )

  test(
    "herdr unreachable before the hand-over: the messages stay queued, no notice, and the next check delivers them, also after a failed execution",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* settled
      const prompts = (yield* herdr.callsTo("send")).length
      const notices = entryPending(db, (yield* db.getSession(id))!.projectId).pipe(
        Effect.map((rows) => rows.filter((r) => r.kind === "notice")),
      )

      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release("unreachable")
      yield* until(herdr.callsTo("send"), (calls) => calls.length > prompts)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "first\n\nsecond")
      assert.deepStrictEqual(yield* notices, [])

      yield* writeEnd(id, "pi", { text: "status: completed" }, 2000)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* settled
      const again = yield* herdr.hold("state", id)
      yield* sessions.send(id, "third")
      yield* again.reached
      yield* again.release("unreachable")
      yield* until(db.pendingInbox(id), (rows) => rows.length === 1)
      yield* TestClock.withLive(Effect.sleep("50 millis"))
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["third"],
      )
      assert.deepStrictEqual(yield* notices, [])
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "third")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])

      yield* writeEnd(id, "pi", { error: "model_not_found" }, 3000)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "failed")
      yield* settled
      const failed = yield* herdr.hold("state", id)
      yield* sessions.send(id, "retry")
      yield* failed.reached
      yield* failed.release("unreachable")
      yield* until(db.pendingInbox(id), (rows) => rows.length === 1)
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["retry"],
      )
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "retry")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
    }),
    { hooked: ["pi"] },
  )
  test(
    "a prompt typed while a delivery awaits the runtime, then the harness dies: the typed execution ends failed with the queued message",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "queued")
      yield* held.reached
      yield* sessions.userPrompt(id, "typed just before exit")
      const typed = yield* db.openExecution(id)
      assert.isDefined(typed)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, alive: false }))
      yield* held.release()
      yield* until(db.getSession(id), (session) => (session ? exitedAt(session) : undefined) != null)
      yield* settled
      assert.isUndefined(yield* db.openExecution(id))
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "failed")
      assert.deepStrictEqual((yield* db.pendingInbox(id)).length, 0)
    }),
    { hooked: ["pi"] },
  )
})
