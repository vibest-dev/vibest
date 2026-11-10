import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Harnesses } from "@vibest/core/harness"
import { Integration } from "@vibest/core/integration"
import { Sessions } from "@vibest/core/sessions"
import { Clock, Effect, Fiber, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { CURSOR } from "./lib/harnesses.ts"
import { settled, TURNS, until, untilVirtual, writeResult } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, spawnWorking, idleSession, test, pick, sqlNotices } from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "send while a turn runs is queued, then delivered merged once the session is idle",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.send(id, "one")
      yield* sessions.send(id, "two")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "one\n\ntwo")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      const sql = yield* SqlClient.SqlClient
      const [round] = yield* sql<{
        input: string
        inbox: number
      }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
      const sent = yield* sql<{
        id: number
      }>`SELECT id FROM inbox WHERE recipient_session_id = ${id} AND content IN ('one', 'two') ORDER BY id`
      assert.strictEqual(round!.input, "one\n\ntwo")
      assert.strictEqual(round!.inbox, sent[1]!.id)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a result newer than the last round, with none open, is delivered once",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: first" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sessions.check(id)
      const results = () =>
        sql<{
          input: string
        }>`SELECT m.input FROM inbox i JOIN ${sql.literal(TURNS)} m ON m.end_id = i.result_event_id WHERE i.sender_session_id = ${id} ORDER BY i.id`.pipe(
          Effect.orDie,
        )
      assert.deepStrictEqual(
        (yield* results()).map((row) => row.input),
        ["do it"],
      )
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: typed" }, 5_000)
      yield* sessions.check(id)
      assert.deepStrictEqual(
        (yield* results()).map((row) => row.input),
        ["do it", ""],
      )
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      yield* sessions.check(id)
      assert.deepStrictEqual(
        (yield* results()).map((row) => row.input),
        ["do it", ""],
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a typed prompt records nothing while vibest holds the session permit",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const held = yield* herdr.hold("open")
      const spawning = yield* Effect.forkChild(sessions.spawn(yield* spawnInput(repo)))
      yield* held.reached
      const id = (yield* db.listSessions())[0]!.id
      const typing = yield* Effect.forkChild(sessions.userPrompt(id, "during launch"))
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      assert.deepStrictEqual(
        yield* sql<{ input: string }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id}`.pipe(
          Effect.orDie,
        ),
        [],
      )
      yield* held.release()
      yield* Fiber.join(spawning)
      yield* Fiber.join(typing)
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const [round] = yield* sql<{
        input: string
      }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
      assert.strictEqual(round!.input, "do it")
    }),
  )

  test(
    "a typed prompt during resume sees the send's round already open",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const name = id
      const first = yield* herdr.hold("state", name)
      const sending = yield* Effect.forkChild(sessions.send(id, "queued text"))
      yield* first.reached
      const second = yield* herdr.hold("state", name)
      yield* first.release()
      yield* second.reached
      assert.strictEqual((yield* (yield* Db).getSession(id))!.turnState, "open")
      const typing = yield* Effect.forkChild(sessions.userPrompt(id, "typed during resume"))
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      const during = yield* sql<{
        input: string
      }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(
        during.map((row) => row.input),
        [""],
      )
      yield* second.release()
      yield* Fiber.join(sending)
      yield* Fiber.join(typing)
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND input = 'typed during resume'`,
        [],
      )
      const [round] = yield* until(
        sql<{
          input: string
          inbox: number | null
        }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
          Effect.orDie,
        ),
        (rows) => rows[0]?.input === "queued text",
      )
      assert.notStrictEqual(round!.inbox, null)
    }),
    { hooked: ["pi"] },
  )

  test(
    "an echo during the runtime prompt returns without waiting and is not a round",
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
        }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(
          Effect.orDie,
        ),
        [],
      )
      yield* held.release()
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(
          Effect.orDie,
        ),
        [],
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a typed prompt during check waits for the lock and is recorded",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("state", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      const typing = yield* Effect.forkChild(sessions.userPrompt(id, "step in"))
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND input = 'step in'`.pipe(Effect.orDie),
        [],
      )
      yield* held.release()
      yield* Fiber.join(checking)
      yield* Fiber.join(typing)
      assert.deepStrictEqual(
        yield* sql<{
          input: string
          status: string
        }>`SELECT input, status FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
          Effect.orDie,
        ),
        [{ input: "step in", status: "working" }],
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a typed round is recorded at hook receipt, not after the lock wait",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const name = id
      const at = yield* Clock.currentTimeMillis
      const held = yield* herdr.hold("state", name)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      const typing = yield* Effect.forkChild(sessions.userPrompt(id, "typed"))
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      yield* herdr.updateAgent(name, (a) => ({ ...a, status: "working", seq: a.seq + 1 }))
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: typed" }, 2000)
      yield* herdr.endTurn(name)
      yield* TestClock.adjust("5 seconds")
      yield* held.release()
      yield* Fiber.join(checking)
      yield* Fiber.join(typing)
      const [round] = yield* sql<{
        startedAt: number
      }>`SELECT started_at AS startedAt FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND input = 'typed'`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(round!.startedAt, at)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a result written while confirm gives up is delivered, and the batch stays delivered",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "not_started")
      yield* sessions.send(id, "next")
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: landed" }, 120_000)
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "completed")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
          Effect.orDie,
        ),
        [{ status: "delivered" }],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "landed")
      assert.strictEqual((yield* sqlNotices(id)).filter((message) => message.includes("task_not_started")).length, 1)
    }),
    { promptsIgnored: true, hooked: ["pi"] },
  )

  test(
    "a result written before a refused prompt is delivered, and the batch stays delivered",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: landed" }, 5_000)
      yield* held.release("busy")
      const done = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "completed")
      assert.strictEqual(done.turnState, "completed")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
          Effect.orDie,
        ),
        [{ status: "delivered" }],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "landed")
      assert.isUndefined(
        (yield* sqlNotices(id)).find(
          (message) => message.includes("task_not_started") || message.includes("send: busy"),
        ),
      )
    }),
    { hooked: ["pi"] },
  )

  test(
    "a refused prompt with no result file still closes the round and fails the batch",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("send", id)
      yield* sessions.send(id, "next")
      yield* held.reached
      yield* held.release("busy")
      const done = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "not_started")
      assert.strictEqual(done.turnState, "not_started")
      assert.deepStrictEqual(
        yield* sql<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
          Effect.orDie,
        ),
        [{ status: "failed" }],
      )
      assert.include((yield* sqlNotices(id)).at(-1)!, "send: busy")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a follow-up send opens its round on that message and its inbox row",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sessions.send(id, "fix the tests")
      const round = yield* until(
        sql<{
          input: string
          inbox: number | null
        }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
          Effect.orDie,
        ),
        (rows) => rows[0]?.input === "fix the tests" && rows[0].inbox !== null,
      )
      const [sent] = yield* sql<{
        id: number
        status: string
      }>`SELECT id, status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'fix the tests'`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(round[0]!.inbox, sent!.id)
      assert.strictEqual(sent!.status, "delivered")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a refused prompt fails only that message and tells the owner; one accepted during it is not failed with it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const sql = yield* SqlClient.SqlClient
      const all = (receiverId: string) =>
        sql<{
          id: number
          status: string
        }>`SELECT id, status AS status FROM inbox WHERE recipient_session_id = ${receiverId} AND kind IN ('task', 'send') AND id > (SELECT min(id) FROM inbox WHERE recipient_session_id = ${receiverId} AND kind IN ('task', 'send')) ORDER BY id`.pipe(
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
        (yield* herdr.callsTo("send")).map((call) => call.text),
        ["do it", "first", "second"],
      )
      assert.deepStrictEqual(pick(yield* db.getSession(id)), { status: "working", turnState: "open" })
    }),
    { hooked: ["pi"] },
  )

  test(
    "the connection breaks after the hand-over: possibly delivered, not sent again, and the turn the session never started closes",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
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
      assert.deepStrictEqual(pick(yield* db.getSession(id)), { status: "idle", turnState: "open" })
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["second"],
      )
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust("10 seconds")
        yield* sessions.check(id)
      }
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).map((c) => c.text),
        ["do it", "first", "second"],
      )
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.deepStrictEqual((yield* notices).slice(1), [
        `task_not_started: vibest did not see ${id} start the turn it was sent (if it starts it late, that turn's result is not collected); it is idle and takes queued messages again.`,
      ])
    }),
    { hooked: ["pi"] },
  )

  test(
    "Cursor: herdr reports no session id, so the hook's conversation id is kept and the session resumes with it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      assert.isNull((yield* db.getSession(id))!.harnessSessionId)
      yield* writeResult(id, "cursor", {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c-123",
        text: "status: completed",
      })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "c-123")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* until(db.getSession(id), (row) => row?.exitedAt != null)
      const starts = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "next")
      const calls = yield* until(herdr.callsTo("open"), (c) => c.length > starts)
      assert.deepStrictEqual(calls.at(-1)!.argv.slice(0, 2), ["cursor-agent", "--resume=c-123"])
      yield* writeResult(id, "cursor", { conversation_id: "c-other", text: "status: completed" }, 5000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "c-123")
      yield* herdr.updateAgent(id, (a) => ({ ...a, session: "h-9" }))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "h-9")
    }),
  )

  test(
    "Cursor on a runtime with no status for it: the task waits for its ready report and, typed, shows it working without a resend; its turn end shows it idle, and an interrupt goes by its open turn",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      yield* Ref.set(herdr.onStarted, (session) =>
        herdr.updateAgent(session, (a) => ({ ...a, status: "unknown", registerPrompt: false })),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo, "cursor"))
      yield* until(db.getSession(id), (w) => !!w && w.startedAt !== null)
      for (let i = 0; i < 20; i++) yield* untilVirtual(Effect.succeed(0), () => true)
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      yield* db.patchLive(id, { ready: yield* Clock.currentTimeMillis })
      yield* untilVirtual(db.getSession(id), (w) => w?.status === "working")
      assert.isTrue((yield* herdr.callsTo("send")).some((c) => c.text?.includes("do it")))
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* TestClock.adjust("40 seconds")
      yield* settled
      assert.isFalse((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("enter")))
      const integration = yield* Integration
      const who = { id, agent: "general", harness: CURSOR.id }
      yield* integration.turnEnd(who, JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }))
      const thought = JSON.stringify({ hook_event_name: "afterAgentThought" })
      yield* integration.prompt(who, thought)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "completed")
      yield* integration.prompt(who, thought)
      yield* settled
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      yield* sessions.send(id, "next")
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "open" && w.status === "working")
      const stopped = yield* sessions.interrupt(id)
      assert.include(stopped.message, "interrupted")
      assert.isTrue((yield* herdr.callsTo("send")).some((c) => c.keys?.includes("ctrl+c")))
      assert.deepInclude(yield* db.getSession(id), { status: "idle", turnState: "interrupted" })
    }),
  )

  test(
    "a send to a session whose harness no plugin provides any more fails with HarnessUnavailable in its notice",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const harnesses = yield* Harnesses
      yield* harnesses.transform((editor) => editor.remove("pi"))
      assert.strictEqual((yield* Effect.flip(harnesses.get("pi")))._tag, "HarnessUnavailable")
      yield* sessions.send(id, "hello")
      const [notice] = yield* until(sqlNotices(id), (rows) => rows.length === 1)
      assert.match(
        notice!,
        new RegExp(`^A message to ${id} was not delivered: no plugin provides harness pi; loaded: `),
      )
      assert.strictEqual(notice!.split("\n\n").at(-1), "hello")
      yield* sessions.check(id)
    }),
  )

  test(
    "a session that cannot be resumed: each accepted message fails on its own, with its own notice",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
      yield* writeResult(id, "cursor", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* settled
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release()
      const notices = yield* until(sqlNotices(id), (rows) => rows.length === 2)
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
    "herdr unreachable before the hand-over: the messages stay queued, no notice, and the next check delivers them, also after a failed turn",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* settled
      const prompts = (yield* herdr.callsTo("send")).length
      const notices = db
        .coordinatorPending((yield* db.getSession(id))!.projectId)
        .pipe(Effect.map((rows) => rows.filter((r) => r.kind === "notice")))

      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release("unreachable")
      yield* until(herdr.callsTo("send"), (calls) => calls.length > prompts)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "first\n\nsecond")
      assert.deepStrictEqual(yield* notices, [])

      yield* writeResult(id, "pi", { text: "status: completed" }, 2000)
      yield* herdr.endTurn(id)
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

      yield* writeResult(id, "pi", { error: "model_not_found" }, 3000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
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
})
