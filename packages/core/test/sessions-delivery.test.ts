import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt, terminalOf } from "@vibest/core/database/db-rows"
import { Harnesses } from "@vibest/core/harnesses"
import { Integration } from "@vibest/core/integration"
import { unwrapped } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import { Clock, Deferred, Effect, Exit, Fiber, PubSub, Ref, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { entryPending, projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { CURSOR, FIRST_IN_ARGV, PI } from "./lib/harnesses.ts"
import { replyOf, settled, EXECUTIONS, until, untilVirtual, writeEnd, yieldToIo } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { harnessArgv, spawnInput, spawnWorking, idleSession, test, pick, sqlNotices } from "./lib/sessions-helpers.ts"

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
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
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
      assert.notStrictEqual(executionStateOf((yield* (yield* Db.Service).session.getSession(id))!), "open")
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
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* db.session.startEntry(
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
      yield* untilVirtual(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "not_started")
      yield* sessions.send(id, "next")
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* sessions.userPrompt(id, "next")
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: landed" }, 120_000)
      yield* untilVirtual(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      yield* untilVirtual(
        sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        (rows) => rows[0]?.status === "delivered",
      )
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
      assert.include(yield* replyOf(id), "landed")
      const notStarted = (yield* sqlNotices(id)).filter((message) => message.includes("did not start"))
      assert.strictEqual(notStarted.length, 1)
      assert.include(notStarted[0], "(pi may be signed out: sign in with pi)")
    }),
    { promptsIgnored: true, hooked: ["pi"] },
  )

  test(
    "a harness that exits after it was seen running, before it took its first message, is reported as an exit without waiting for the ready timeout",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository))
      yield* until(runtime.callsTo("process"), (calls) => calls.length > 0)
      const terminal = terminalOf((yield* db.session.getSession(id))!).id
      yield* runtime.updateAgent(id, (agent) => ({ ...agent, alive: false }))
      yield* PubSub.publish(runtime.events, { type: "exited", terminal: { id: terminal } })

      const notices = yield* until(sqlNotices(id), (all) =>
        all.some((message) => message.includes("exited before it started working")),
      )

      assert.isUndefined(notices.find((message) => message.includes("did not start working")))
      assert.isNotNull(exitedAt((yield* db.session.getSession(id))!))
    }),
    { promptsIgnored: true, hooked: ["pi"] },
  )

  test(
    "a typed start whose command has not left the shell yet is not an exit: the harness starts later and takes its first message",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      yield* Ref.set(runtime.onStarted, (session) =>
        runtime.updateAgent(session, (agent) => ({ ...agent, alive: false })),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository))
      yield* until(runtime.callsTo("process"), (calls) => calls.length > 0)
      yield* yieldToIo
      yield* runtime.updateAgent(id, (agent) => ({ ...agent, alive: true, status: "working" }))
      yield* TestClock.adjust("1 second")
      yield* settled
      const row = (yield* db.session.getSession(id))!
      assert.isNull(exitedAt(row))
      assert.strictEqual(executionStateOf(row), "open")
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
        db.session.getSession(id),
        (w): w is NonNullable<typeof w> => (w ? executionStateOf(w) : undefined) === "completed",
      )

      assert.strictEqual(executionStateOf(done), "completed")
      yield* settled
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        [{ status: "delivered" }],
      )
      assert.include(yield* replyOf(id), "landed")
      assert.isUndefined(
        (yield* sqlNotices(id)).find((message) => message.includes("did not start") || message.includes("send: busy")),
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
      const notices = yield* until(sqlNotices(id), (all) => all.at(-1)?.includes("send: busy") === true)
      assert.include(notices.at(-1)!, "send: busy")
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "not_started")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'next'`.pipe(Effect.orDie),
        [{ status: "failed" }],
      )
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
      assert.match(notices.at(-1)!, /^A message to .* was not delivered: .*send: failed/)
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
        ["first", "second"],
      )
      assert.deepStrictEqual(pick(yield* db.session.getSession(id)), { status: "working", executionState: "open" })
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
      assert.deepStrictEqual(pick(yield* db.session.getSession(id)), { status: "idle", executionState: "open" })
      assert.deepStrictEqual(
        (yield* db.inbox.pendingInbox(id)).map((r) => r.message),
        ["second"],
      )

      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust("10 seconds")
        yield* sessions.check(id)
      }

      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).map((c) => unwrapped(c.text!)),
        ["first", "second"],
      )
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
      const later = (yield* notices).slice(1)
      assert.strictEqual(later.length, 1)
      assert.include(later[0], "did not start the execution it was sent; it is idle and takes queued messages again")
    }),
    { hooked: ["pi"] },
  )

  test(
    "Cursor: herdr reports no session id, so the execution end's conversation id is kept and the session resumes with it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      assert.isNull((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null)
      yield* writeEnd(id, "cursor", {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c-123",
        text: "status: completed",
      })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "c-123")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* until(db.session.getSession(id), (row) => (row ? exitedAt(row) : undefined) != null)
      const starts = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "next")
      const calls = yield* until(herdr.callsTo("open"), (c) => c.length > starts)
      assert.deepStrictEqual(harnessArgv(calls.at(-1)!.argv).slice(0, 2), ["cursor-agent", "--resume=c-123"])
      yield* until(db.session.executionAccepted(id), (accepted) => accepted)
      yield* writeEnd(id, "cursor", { conversation_id: "c-other", text: "status: completed" }, 5000)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "c-other")
      yield* herdr.updateAgent(id, (a) => ({ ...a, session: "h-9" }))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "h-9")
    }),
  )

  test(
    "Cursor: a hook from an earlier process does not record its conversation id",
    Effect.gen(function* () {
      const integration = yield* Integration.Service
      const { id, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      const current = (yield* db.session.currentProcessId(id))!
      const event = JSON.stringify({ hook_event_name: "beforeSubmitPrompt", conversation_id: "c-old", prompt: "x" })
      yield* integration.prompt({ id, entry: false, harness: "cursor", process: current - 1 }, event)
      assert.isNull((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null)
      yield* integration.prompt({ id, entry: false, harness: "cursor", process: current }, event)
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "c-old")
    }),
  )

  test(
    "an entry session whose harness reports its execution ends but does not pull its inbox gets a queued message typed when idle",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* herdr.seedAgent("test/cursor-entry")

      const { sessionId } = yield* db.session.startEntry(
        yield* projectOf(repo),
        "cursor",
        false,
        { runtime: RUNTIME, address: { machine: "local", id: "test/cursor-entry" } },
        { agent: "coordinator" },
      )

      yield* db.session.patchLive(sessionId, { ready: yield* Clock.currentTimeMillis })
      yield* sessions.deliverTo(sessionId, "hello entry")
      yield* untilVirtual(herdr.callsTo("send"), (calls) =>
        calls.some((c) => c.terminal === "test/cursor-entry" && c.text?.includes("hello entry") === true),
      )
    }),
  )

  test(
    "typed delivery empties the input box with the harness's clear keys right before each message, whatever the box holds; a harness without clear keys gets none",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const { id, sessions } = yield* spawnWorking(repo, "cursor")
      yield* writeEnd(id, "cursor", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* settled
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text?.includes("next") === true))
      const cursorTerminal = (yield* herdr.terminalOf(id))?.id
      const toCursor = (yield* herdr.callsTo("send")).filter((c) => c.terminal === cursorTerminal)
      const typed = toCursor.flatMap((c, i) => (c.text === undefined ? [] : [toCursor[i - 1]?.keys]))
      assert.deepStrictEqual(typed, [["ctrl+u"]])
      const pi = yield* spawnWorking(repo, "pi")
      const piTerminal = (yield* herdr.terminalOf(pi.id))?.id
      const toPi = (yield* herdr.callsTo("send")).filter((c) => c.terminal === piTerminal)
      assert.isFalse(toPi.some((c) => c.keys !== undefined))
    }),
  )

  test(
    "a harness that takes its first message in its launch argv and reports its start and end before vibestd looks: one execution, opened before the process started, carries the task and completes; nothing is typed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const integration = yield* Integration.Service
      yield* Ref.set(herdr.onStarted, (session) =>
        Effect.gen(function* () {
          const who = { id: session, entry: false, harness: FIRST_IN_ARGV.id }
          yield* herdr.updateAgent(session, (a) => ({ ...a, status: "unknown", registerPrompt: false }))
          yield* integration.prompt(who, JSON.stringify({ hook_event_name: "afterAgentThought" }))
          yield* integration.executionEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }))
        }),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository, "first"))
      yield* until(db.session.getSession(id), (row) => row !== undefined && executionStateOf(row) === "completed")
      yield* settled
      const sql = yield* SqlClient.SqlClient

      const executions = yield* sql<{
        status: string
        input: string
      }>`SELECT status, input FROM ${sql.literal(EXECUTIONS)} e WHERE e.session_id = ${id}`.pipe(Effect.orDie)

      assert.deepStrictEqual(
        executions.map((e) => [e.status, e.input.includes("do it")]),
        [["completed", true]],
      )
      const [open] = yield* herdr.callsTo("open")
      assert.include(open!.argv.slice(-2).join(" "), "--first")
      assert.include(open!.argv.at(-1)!, "do it")
      assert.isFalse((yield* herdr.callsTo("send")).some((call) => call.text !== undefined))
    }),
    { harnesses: [PI, FIRST_IN_ARGV] },
  )

  test(
    "a resume of a harness that takes its first message in its launch argv whose terminal fails to open closes the execution it opened, so the next send resumes again",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const integration = yield* Integration.Service
      yield* Ref.set(herdr.onStarted, (session) =>
        Effect.gen(function* () {
          const who = { id: session, entry: false, harness: FIRST_IN_ARGV.id }
          yield* integration.prompt(who, JSON.stringify({ hook_event_name: "afterAgentThought" }))
          yield* integration.executionEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }))
        }),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository, "first"))
      yield* until(db.session.getSession(id), (row) => row !== undefined && executionStateOf(row) === "completed")
      yield* db.session.noteConversation(id, "conversation-1")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* until(db.session.getSession(id), (row) => row !== undefined && exitedAt(row) !== null)
      const placed = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open", id)
      yield* sessions.send(id, "again")
      yield* held.reached
      yield* held.release("failed")
      yield* until(db.session.openExecution(id), (open) => open === undefined)
      yield* sessions.send(id, "once more")
      const opens = yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 2)
      assert.include(opens.at(-1)!.argv.at(-1)!, "once more")
    }),
    { harnesses: [PI, FIRST_IN_ARGV] },
  )

  test(
    "Cursor on a runtime with no status for it: the task is in its launch argv; its first activity report accepts it and shows it working, with no resend; its execution end shows it idle, and an interrupt goes by its open execution",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* Ref.set(herdr.onStarted, (session) =>
        herdr.updateAgent(session, (a) => ({ ...a, status: "unknown", registerPrompt: false })),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo, "cursor"))
      yield* until(db.session.getSession(id), (w) => !!w && (w.process?.placedAt ?? null) !== null)

      for (let i = 0; i < 20; i++) yield* untilVirtual(Effect.succeed(0), () => true)
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      assert.include((yield* herdr.callsTo("open"))[0]!.argv.at(-1)!, "do it")
      const integration = yield* Integration.Service
      const who = { id, entry: false, harness: CURSOR.id }
      const thought = JSON.stringify({ hook_event_name: "afterAgentThought" })
      yield* integration.prompt(who, thought)
      assert.strictEqual((yield* db.session.getSession(id))!.status, "working")
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      yield* TestClock.adjust("40 seconds")
      yield* settled
      assert.isFalse((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("enter")))
      yield* integration.executionEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }))
      yield* untilVirtual(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      const typedTasks = (yield* herdr.callsTo("send")).filter((c) => c.text !== undefined).length
      yield* integration.prompt(who, thought)
      const byUser = (yield* db.session.getSession(id))!
      assert.strictEqual(byUser.status, "working")
      assert.strictEqual(executionStateOf(byUser), "open")
      const userExecution = (yield* db.session.openExecution(id))!
      yield* sessions.send(id, "queued while the user's prompt runs")
      yield* settled
      assert.strictEqual((yield* herdr.callsTo("send")).filter((c) => c.text !== undefined).length, typedTasks)
      yield* integration.prompt(who, JSON.stringify({ hook_event_name: "postToolUse" }))
      yield* integration.executionEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "user done" }))
      yield* until(herdr.callsTo("send"), (calls) =>
        calls.some((c) => c.text?.includes("queued while the user's prompt runs") === true),
      )
      const userEnd = (yield* db.session.latestReply(id))!
      assert.strictEqual(userEnd.execution, userExecution)
      assert.strictEqual(userEnd.text, "user done")
      assert.notStrictEqual(yield* db.session.openExecution(id), userExecution)
      yield* integration.prompt(who, thought)
      yield* integration.executionEnd(
        who,
        JSON.stringify({ hook_event_name: "afterAgentResponse", text: "queued done" }),
      )
      yield* untilVirtual(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      yield* sessions.send(id, "next")
      yield* untilVirtual(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      yield* integration.prompt(who, thought)
      yield* untilVirtual(
        db.session.getSession(id),
        (w) => w !== undefined && executionStateOf(w) === "open" && w.status === "working",
      )
      const stopped = yield* sessions.interrupt(id)
      assert.include(stopped.message, "interrupted")
      assert.isTrue((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("ctrl+c")))
      const row = (yield* db.session.getSession(id))!
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
      assert.match(notice!, /^A message to .* was not delivered: no plugin provides harness leaving-pi; loaded: /)
      assert.strictEqual(notice!.split("\n\n").at(-1), "hello")
      yield* sessions.check(id)
    }),
    { hooked: ["leaving-pi"] },
  )

  {
    const failing = Deferred.makeUnsafe<void>()
    const go = Deferred.makeUnsafe<void>()
    test(
      "a failed delivery marks its rows failed under the session lock: a check meanwhile does not deliver them as well",
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const sql = yield* SqlClient.SqlClient
        const harnesses = yield* Harnesses.Service
        const loaded = yield* Scope.make()
        yield* harnesses.transform((editor) => editor.add({ ...PI, id: "leaving-pi" })).pipe(Scope.provide(loaded))
        const { id, sessions } = yield* spawnWorking(yield* makeRepository, "leaving-pi")
        yield* writeEnd(id, "leaving-pi", { text: "status: completed" })
        yield* herdr.endExecution(id)
        yield* sessions.check(id)
        yield* Scope.close(loaded, Exit.void)
        yield* sessions.send(id, "hello")
        yield* Deferred.await(failing)
        yield* harnesses
          .transform((editor) => editor.add({ ...PI, id: "leaving-pi" }))
          .pipe(Scope.provide(yield* Scope.make()))
        const checking = yield* Effect.forkChild(sessions.check(id))

        for (let i = 0; i < 30; i++) yield* yieldToIo
        yield* Deferred.succeed(go, undefined)
        yield* Fiber.join(checking)
        yield* settled

        const [row] = yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE session_id = ${id} AND content = 'hello'`.pipe(Effect.orDie)

        const sent = (yield* herdr.callsTo("send")).filter((call) => call.text?.includes("hello")).length
        assert.deepStrictEqual({ status: row?.status, sent }, { status: "failed", sent: 0 })
      }),
      {
        hooked: ["leaving-pi"],
        db: (db) => ({
          ...db,
          inbox: {
            ...db.inbox,
            setInboxStatus: (sessionId, ids, status, from, into) =>
              status === "failed" && from === undefined
                ? Deferred.succeed(failing, undefined).pipe(
                    Effect.andThen(Deferred.await(go)),
                    Effect.andThen(db.inbox.setInboxStatus(sessionId, ids, status, from, into)),
                  )
                : db.inbox.setInboxStatus(sessionId, ids, status, from, into),
          },
        }),
      },
    )
  }

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

      for (const message of notices) assert.include(message, "exited before the runtime reported its session id")
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
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

      const notices = entryPending(db, (yield* db.session.getSession(id))!.projectId).pipe(
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
      yield* until(db.inbox.pendingInbox(id), (rows) => rows.length === 1)
      yield* TestClock.withLive(Effect.sleep("50 millis"))
      assert.deepStrictEqual(
        (yield* db.inbox.pendingInbox(id)).map((r) => r.message),
        ["third"],
      )
      assert.deepStrictEqual(yield* notices, [])
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "third")
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])

      yield* writeEnd(id, "pi", { error: "model_not_found" }, 3000)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "failed")
      yield* settled
      const failed = yield* herdr.hold("state", id)
      yield* sessions.send(id, "retry")
      yield* failed.reached
      yield* failed.release("unreachable")
      yield* until(db.inbox.pendingInbox(id), (rows) => rows.length === 1)
      assert.deepStrictEqual(
        (yield* db.inbox.pendingInbox(id)).map((r) => r.message),
        ["retry"],
      )
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "retry")
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
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
      const typed = yield* db.session.openExecution(id)
      assert.isDefined(typed)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, alive: false }))
      yield* held.release()
      yield* until(db.session.getSession(id), (session) => (session ? exitedAt(session) : undefined) != null)
      yield* settled
      assert.isUndefined(yield* db.session.openExecution(id))
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "failed")
      assert.deepStrictEqual((yield* db.inbox.pendingInbox(id)).length, 0)
    }),
    { hooked: ["pi"] },
  )
})
