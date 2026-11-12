import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { AWAY, Inbox, LEASE, line, LINE_MAX } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { MISMATCH_ACTION, PROTOCOL, sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import type { InboxRow } from "@vibest/schema/session"
import * as Http from "@vibest/server/http"
import { Duration, Effect, Fiber, type Scope } from "effect"
import * as Headers from "effect/http/Headers"
import { TestClock } from "effect/testing"

import {
  FakeRuntime,
  makeRepository,
  settled,
  testLayer,
  type TestServices,
  until,
  replyText,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const row = (over: Partial<InboxRow>): InboxRow => ({
  id: 1,
  sender: "349f65b2-349f-4349-8349-349f65b2349f",
  recipient: null,
  kind: "notice",
  message: "full text",
  status: "pending",
  ...over,
})

describe("the line a delivery shows", () => {
  const who = () => ({ agent: "general", title: "Fix the guard rule" })
  it("names the agent type, title and session id; a notice shows its first line", () => {
    assert.strictEqual(
      line([row({ kind: "send" })], who),
      'General Agent "Fix the guard rule" sent a message (349f65b2)',
    )
    const reviewer = () => ({ agent: "reviewer", title: "Review the guard fix" })
    assert.strictEqual(
      line([row({ kind: "send", sender: "95603b88-9560-4956-8956-95603b889560" })], reviewer),
      'Reviewer Agent "Review the guard fix" sent a message (95603b88)',
    )
    assert.strictEqual(line([row({ kind: "notice", message: "w1 exited.\nmore" })], who), "Notice: w1 exited.")
  })

  it("a batch is named by its last row; a long title is cut, the id and the count kept", () => {
    const batch = [row({ kind: "send" }), row({ id: 2, kind: "send" }), row({ id: 3, kind: "send" })]
    assert.strictEqual(line(batch, who), 'General Agent "Fix the guard rule" sent a message (349f65b2) · +2 more')
    const long = line(batch, () => ({ agent: "general", title: "x".repeat(300) }))
    assert.strictEqual([...long].length, LINE_MAX)
    assert.include(long, `x…" sent a message (349f65b2) · +2 more`)
  })
})

const project = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const key = yield* projectOf(repo)
  const entry = yield* db.startEntry(key, "claude", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: "test/coord" },
  })
  yield* herdr.seedAgent("test/coord")
  const sessions = yield* Sessions
  const { id: worker } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    parentSessionId: "creator",
    projectId: key,
    name: "Fix the guard",
    prompt: "do it",
    runtime: "herdr",
    harness: "claude",
  })
  const projectId = entry.projectId
  const handle = yield* Http.make
  const call = (path: string, who: Partial<SessionIdentity> & { sessionId: string }, body = "{}") =>
    handle({
      path,
      headers: Headers.fromInput(sessionHeaders({ projectId: String(projectId), harness: "claude", ...who })),
      body,
    })
  return { db, herdr, entryId: entry.sessionId, worker, projectId, repo, key, sessions, call, inbox: yield* Inbox }
})

const statusOf = (db: Db["Service"], worker: string) =>
  db.latestInbox(worker, "notice").pipe(Effect.map((r) => r?.status))

describe("vibestd's HTTP API", () => {
  test(
    "the caller is checked: protocol 409, unknown session 404, missing or other project or harness 403, a subagent's poll 403",
    Effect.gen(function* () {
      const { call, db, entryId, worker, projectId } = yield* project
      const handle = yield* Http.make
      const raw = (headers: Record<string, string>) =>
        handle({ path: "/inbox/poll", headers: Headers.fromInput(headers), body: "{}" })
      const own = sessionHeaders({ sessionId: entryId, harness: "claude" })
      const older = yield* raw({ ...own, "vibest-protocol": String(PROTOCOL - 1) })
      assert.strictEqual(older.status, 409)
      assert.deepInclude(older.body, {
        protocol: PROTOCOL,
        version: VERSION,
        message: `this agent runs an older vibest (protocol ${PROTOCOL - 1}), vibestd runs ${VERSION} (protocol ${PROTOCOL}); run vibest update to restart this agent on it`,
        action: MISMATCH_ACTION,
      })
      const named = yield* raw({
        ...own,
        "vibest-protocol": String(PROTOCOL - 1),
        "vibest-plugin-version": "0.0.1-old",
      })
      assert.include(
        (named.body as { error: string }).error,
        `this agent runs vibest 0.0.1-old (protocol ${PROTOCOL - 1}), vibestd runs ${VERSION}`,
      )
      const newer = yield* raw({ ...own, "vibest-protocol": String(PROTOCOL + 1) })
      assert.deepInclude(newer.body, {
        message: `vibestd is older (${VERSION}); run vibest update`,
        action: "vibest update",
      })
      assert.strictEqual((newer.body as { error: string }).error, `vibestd is older (${VERSION}); run vibest update`)
      assert.strictEqual((yield* raw({ ...own, "vibest-protocol": "" })).status, 409)
      assert.strictEqual(
        (yield* call("/inbox/poll", { sessionId: "05c00000-05c0-405c-805c-05c0000005c0" })).status,
        404,
      )
      assert.strictEqual((yield* raw(own)).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: entryId, harness: "pi" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: entryId, harness: "" })).status, 403)
      assert.strictEqual((yield* call("/hooks/cursor/guard", { sessionId: worker, harness: "claude" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: entryId, projectId: "999" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: worker })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: entryId })).status, 200)
      assert.strictEqual((yield* call("/nope", { sessionId: entryId })).status, 404)
      yield* db.startEntry(projectId, "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* db.noteConversation(entryId, "pi-conversation")
      const old = yield* call("/inbox/poll", { sessionId: entryId, harnessSessionId: "claude-conversation" })
      assert.strictEqual(old.status, 403)
      assert.strictEqual((yield* db.entryOf(projectId))?.harnessSessionId, "pi-conversation")
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: entryId, harness: "pi" })).status, 403)
    }),
  )

  test(
    "the integration version and protocol are recorded per session, also on a protocol mismatch",
    Effect.gen(function* () {
      const { call, db, entryId, worker, projectId } = yield* project
      const integration = (id: string) =>
        id === entryId
          ? Effect.map(db.entryOf(projectId), (m) => m?.integration)
          : Effect.map(db.getSession(id), (s) => s?.metadata.integration)
      for (const id of [entryId, worker]) {
        assert.isUndefined(yield* integration(id))
        yield* call("/inbox/ack", { sessionId: id, pluginVersion: "1.0.0" }, JSON.stringify({ ids: [] }))
        assert.deepStrictEqual(yield* integration(id), { version: "1.0.0", protocol: PROTOCOL })
        const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "0.9.0" }), "vibest-protocol": "1" }
        const handle = yield* Http.make
        assert.strictEqual(
          (yield* handle({ path: "/inbox/poll", headers: Headers.fromInput(old), body: "{}" })).status,
          409,
        )
        assert.deepStrictEqual(yield* integration(id), { version: "0.9.0", protocol: 1 })
      }
      yield* db.updateSession(worker, { lastActive: 1 })
      assert.deepStrictEqual(yield* integration(worker), { version: "0.9.0", protocol: 1 })
    }),
  )

  test(
    "poll hands a batch out once, each row leased; ack delivers it; an expired lease hands it out again",
    Effect.gen(function* () {
      const { call, db, inbox, entryId, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, message: "hello" })
      const first = (yield* call("/inbox/poll", { sessionId: entryId })).body as Http.Reply["body"] & {
        ids: Array<number>
        line: string
        text: string
      }
      assert.lengthOf(first.ids, 1)
      assert.strictEqual(first.line, "Notice: hello")
      assert.strictEqual(first.text, "hello")
      assert.strictEqual(yield* statusOf(db, worker), "delivering")
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
      yield* TestClock.adjust(LEASE)
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, first.ids)
      const acked = yield* call("/inbox/ack", { sessionId: entryId }, JSON.stringify({ ids: first.ids }))
      assert.deepStrictEqual(acked, { status: 200, body: { acked: first.ids } })
      assert.strictEqual(yield* statusOf(db, worker), "delivered")
      assert.deepStrictEqual(yield* inbox.ack(projectId, first.ids), [])
      assert.strictEqual((yield* call("/inbox/ack", { sessionId: entryId }, "{}")).status, 400)
    }),
  )

  test(
    "each row keeps its own lease: a newer batch does not renew an older one that nobody acked",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      const wait = (seconds: number) =>
        Effect.gen(function* () {
          for (let i = 0; i < seconds; i++) {
            yield* TestClock.adjust("1 second")
            assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
          }
        })
      yield* inbox.enqueue({ sessionId: worker, message: "old" })
      const old = yield* inbox.poll(projectId)
      yield* wait(20)
      yield* inbox.enqueue({ sessionId: worker, message: "new" })
      const newer = yield* inbox.poll(projectId)
      assert.notDeepEqual(newer.ids, old.ids)
      yield* wait(9)
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, old.ids)
      assert.deepStrictEqual(yield* inbox.ack(projectId, old.ids, newer.ids), old.ids)
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, newer.ids)
      assert.strictEqual(yield* statusOf(db, worker), "delivering")
    }),
  )

  test(
    "a vibestd restart puts a polling entry session's handed-out rows back to pending",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, message: "hello" })
      const { ids } = yield* inbox.poll(projectId)
      yield* db.recoverDelivering(["claude"], () => "")
      assert.strictEqual(yield* statusOf(db, worker), "pending")
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, ids)
      yield* db.recoverDelivering([], () => "")
      assert.strictEqual(yield* statusOf(db, worker), "failed")
    }),
  )

  test(
    "a plugin that stopped polling: its lease goes back to pending after AWAY; an ack of a pending row still counts",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, message: "hello" })
      const { ids } = yield* inbox.poll(projectId)
      assert.strictEqual(yield* statusOf(db, worker), "delivering")
      yield* TestClock.adjust(AWAY)
      yield* TestClock.adjust("2 seconds")
      yield* until(statusOf(db, worker), (s) => s === "pending")
      assert.deepStrictEqual(yield* inbox.ack(projectId, ids), ids)
      assert.strictEqual(yield* statusOf(db, worker), "delivered")
      yield* inbox.enqueue({ sessionId: worker, message: "again" })
      const next = yield* inbox.poll(projectId)
      assert.deepStrictEqual(yield* inbox.ack(projectId + 1, next.ids), [])
    }),
  )

  test(
    "each poll re-arms the away timer: the lease ends AWAY after the last poll, not the first",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, message: "hello" })
      yield* inbox.poll(projectId)
      yield* TestClock.adjust(Duration.subtract(AWAY, Duration.seconds(1)))
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
      yield* TestClock.adjust("2 seconds")
      yield* settled
      assert.strictEqual(yield* statusOf(db, worker), "delivering")
      yield* TestClock.adjust(AWAY)
      yield* until(statusOf(db, worker), (s) => s === "pending")
    }),
  )

  test(
    "the prompt hook is answered while the session's lock is held",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      yield* until(db.getSession(worker), (s) => s?.executionState === "open")
      const held = yield* herdr.hold("state", worker)
      const checking = yield* Effect.forkChild(sessions.check(worker))
      yield* held.reached
      const hook = yield* call(
        "/hooks/claude/prompt",
        { sessionId: worker },
        JSON.stringify({ hook_event_name: "PromptSubmit", text: "do it", origin: "composer" }),
      )
      assert.strictEqual(hook.status, 204)
      yield* held.release()
      yield* Fiber.join(checking)
    }),
  )

  test(
    "a request from an earlier process records no conversation from its headers",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      const current = (yield* db.currentProcessId(worker))!
      const before = (yield* db.getSession(worker))!.harnessSessionId
      const old = String(current - 1)
      yield* call("/session/ready", { sessionId: worker, process: old, harnessSessionId: "old-by-header" })
      yield* call(
        "/hooks/claude/prompt",
        { sessionId: worker, process: old },
        JSON.stringify({ hook_event_name: "PromptSubmit", text: "x", origin: "composer" }),
      )
      assert.strictEqual((yield* db.getSession(worker))!.harnessSessionId, before)
      yield* call("/session/ready", { sessionId: worker, process: String(current), harnessSessionId: "current" })
      assert.strictEqual((yield* db.getSession(worker))!.harnessSessionId, "current")
    }),
  )

  test(
    "a late Ready from the process a restart replaced changes nothing; the restarted harness's Ready is taken",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.getSession(worker), (s) => s?.startedAt != null)
      const first = (yield* db.currentProcessId(worker))!
      const ready = (process: number, pid: number, pluginVersion = VERSION) =>
        call("/session/ready", { sessionId: worker, process: String(process), pluginVersion }, JSON.stringify({ pid }))
      assert.deepStrictEqual((yield* ready(first, 111)).body, { process: first })
      yield* db.restartProcess(worker)
      const second = (yield* db.currentProcessId(worker))!
      assert.notStrictEqual(second, first)
      const late = yield* ready(first, 111)
      assert.strictEqual(late.status, 204)
      assert.isUndefined(yield* db.readyAt(worker))
      assert.isUndefined((yield* db.getSession(worker))!.metadata.pid)
      assert.deepStrictEqual((yield* ready(first, 222, "0.0.2-next")).body, { process: second })
      assert.isNumber(yield* db.readyAt(worker))
      assert.deepInclude((yield* db.getSession(worker))!.metadata, {
        pid: 222,
        integration: { version: "0.0.2-next", protocol: PROTOCOL },
      })
    }),
  )

  test(
    "execution-end, prompt and guard hooks: vibestd keeps the execution start and end",
    Effect.gen(function* () {
      const { call, db, worker, entryId } = yield* project
      const layout = yield* Layout
      const ready = yield* call("/session/ready", { sessionId: worker })
      assert.strictEqual(ready.status, 200)
      assert.isNumber((ready.body as { process?: unknown }).process)
      const prompt = yield* call(
        "/hooks/claude/prompt",
        { sessionId: worker },
        JSON.stringify({ hook_event_name: "PromptSubmit", text: "next step", origin: "composer" }),
      )
      assert.strictEqual(prompt.status, 204)
      const end = yield* call(
        "/hooks/claude/execution-end",
        { sessionId: worker },
        JSON.stringify({
          hook_event_name: "ExecutionComplete",
          reason: "answer",
          last_assistant_message: "Fixed the guard.",
        }),
      )
      assert.strictEqual(end.status, 204)
      assert.include(yield* replyText(worker), "Fixed the guard.")
      yield* call(
        "/hooks/claude/execution-end",
        { sessionId: entryId },
        JSON.stringify({ hook_event_name: "ExecutionComplete", reason: "answer", last_assistant_message: "x" }),
      )
      assert.strictEqual(yield* replyText(entryId), "")
      const key = (yield* db.getSession(worker))!.projectId
      const tool = (file: string) =>
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "x" }, cwd: "/tmp" })
      const other = yield* call("/hooks/claude/guard", { sessionId: worker }, tool(`${layout.projects}/elsewhere/x`))
      assert.isString((other.body as { deny?: string }).deny)
      const own = yield* call("/hooks/claude/guard", { sessionId: worker }, tool(`${layout.artifacts(key)}/notes.md`))
      assert.deepStrictEqual(own, { status: 200, body: {} })
      const coordinator = yield* call("/hooks/claude/guard", { sessionId: entryId }, tool("/tmp/x"))
      assert.isString((coordinator.body as { deny?: string }).deny)
      const plan = yield* call("/hooks/claude/guard", { sessionId: entryId }, tool(`${layout.artifacts(key)}/plan.md`))
      assert.deepStrictEqual(plan, { status: 200, body: {} })
      const bad = yield* call("/hooks/claude/guard", { sessionId: worker }, "not json")
      assert.isString((bad.body as { deny?: string }).deny)
    }),
  )

  test(
    "an ordinary session whose agent is named entry gets the session guard rules, not the entry session's",
    Effect.gen(function* () {
      const { call, repo, key, sessions } = yield* project
      const { id } = yield* sessions.spawn({
        machine: { id: "local" },
        root: repo,
        parentSessionId: "creator",
        projectId: key,
        name: "Named entry",
        prompt: "do it",
        runtime: "herdr",
        harness: "claude",
        agent: "entry",
      })
      const write = JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x", content: "x" },
        cwd: "/tmp",
      })
      assert.deepStrictEqual(yield* call("/hooks/claude/guard", { sessionId: id }, write), { status: 200, body: {} })
    }),
  )
})
