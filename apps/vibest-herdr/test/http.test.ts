// vibestd's HTTP API (packages/server/src/http.ts) and the poll / ack delivery under it (core/inbox.ts), over the fake
// runtime. The handler is called directly; one test serves it on a real unix socket.
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { AWAY, Inbox, LEASE, line, LINE_MAX } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { repositoryKey } from "@vibest/core/worktree"
import { MISMATCH_ACTION, PROTOCOL, sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import type { InboxRow } from "@vibest/schema/session"
import * as Http from "@vibest/server/http"
import { Clock, Effect, Fiber, FileSystem, Layer, type Scope } from "effect"
import * as Headers from "effect/http/Headers"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { FakeRuntime, makeRepository, testLayer, type TestServices, until } from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const row = (over: Partial<InboxRow>): InboxRow => ({
  id: 1,
  sessionId: "349f65b2",
  kind: "result",
  message: "full text",
  details: {},
  status: "pending",
  createdAt: 0,
  ...over,
})

describe("the line a delivery shows", () => {
  const who = () => ({ agent: "general", title: "Fix guard scratch rule" })
  it("names the agent type, title, status and session id", () => {
    assert.strictEqual(
      line([row({ details: { status: "completed" } })], who),
      'General Agent "Fix guard scratch rule" completed (349f65b2)',
    )
    const reviewer = () => ({ agent: "reviewer", title: "Review the guard fix" })
    assert.strictEqual(
      line([row({ sessionId: "95603b88", details: { status: "failed" } })], reviewer),
      'Reviewer Agent "Review the guard fix" failed (95603b88)',
    )
    assert.strictEqual(
      line([row({ kind: "report" })], who),
      'General Agent "Fix guard scratch rule" sent a message (349f65b2)',
    )
    const status = (details: Record<string, unknown>) => line([row({ details })], who).split('" ')[1]
    assert.strictEqual(status({ status: "failed" }), "failed (349f65b2)")
    assert.strictEqual(status({ status: "completed", error: "the turn ended on an API error" }), "failed (349f65b2)")
    assert.strictEqual(status({ status: "failed", error: "interrupted" }), "was interrupted (349f65b2)")
    assert.strictEqual(line([row({ kind: "notice", message: "w1 exited.\nmore" })], who), "Notice: w1 exited.")
  })

  it("a batch is named by its last row; a long title is cut, the id and the count kept", () => {
    const batch = [
      row({ kind: "report" }),
      row({ id: 2, kind: "report" }),
      row({ id: 3, details: { status: "completed" } }),
    ]
    assert.strictEqual(line(batch, who), 'General Agent "Fix guard scratch rule" completed (349f65b2) · +2 more')
    const long = line(batch, () => ({ agent: "general", title: "x".repeat(300) }))
    assert.strictEqual([...long].length, LINE_MAX)
    assert.include(long, `x…" completed (349f65b2) · +2 more`)
  })
})

/** A Claude main agent idle at test/coord, and a worker of its project. */
const project = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const key = yield* repositoryKey(repo)
  const main = yield* db.coordinatorLaunch(key, "claude", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: "test/coord" },
  })
  yield* herdr.seedAgent("test/coord")
  const sessions = yield* Sessions
  const { id: worker } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    key,
    name: "Fix the guard",
    prompt: "do it",
    harness: "claude",
  })
  const projectId = main.projectId
  const handle = yield* Http.make
  const call = (path: string, who: Partial<SessionIdentity> & { sessionId: string }, body = "{}") =>
    handle({
      path,
      headers: Headers.fromInput(sessionHeaders({ projectId: String(projectId), harness: "claude", ...who })),
      body,
    })
  return { db, herdr, main: main.sessionId, worker, projectId, call, inbox: yield* Inbox }
})

const statusOf = (db: Db["Service"], worker: string) =>
  db.latestInbox(worker, "report").pipe(Effect.map((r) => r?.status))

describe("vibestd's HTTP API", () => {
  test(
    "the caller is checked: protocol 409, unknown session 404, missing or other project or harness 403, a subagent's poll 403",
    Effect.gen(function* () {
      const { call, db, main, worker, projectId } = yield* project
      const handle = yield* Http.make
      const raw = (headers: Record<string, string>) =>
        handle({ path: "/inbox/poll", headers: Headers.fromInput(headers), body: "{}" })
      const own = sessionHeaders({ sessionId: main, harness: "claude" })
      // An older caller is told to restart itself; a newer one, that vibestd is old. Both with the command to run.
      const older = yield* raw({ ...own, "vibest-protocol": String(PROTOCOL - 1) })
      assert.strictEqual(older.status, 409)
      assert.deepInclude(older.body, {
        protocol: PROTOCOL,
        version: VERSION,
        message: `this agent runs an older vibest (protocol ${PROTOCOL - 1}), vibestd runs ${VERSION} (protocol ${PROTOCOL}); run vibest update to restart this agent on it`,
        action: MISMATCH_ACTION,
      })
      // A caller that sends its own version is named by it.
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
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: "nosuch00" })).status, 404)
      // Missing project id: refused.
      assert.strictEqual((yield* raw(own)).status, 403)
      // Another harness than the session's, or none: refused before anything is recorded.
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: main, harness: "pi" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: main, harness: "" })).status, 403)
      assert.strictEqual((yield* call("/hooks/cursor/guard", { sessionId: worker, harness: "claude" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: main, projectId: "999" })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: worker })).status, 403)
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: main })).status, 200)
      assert.strictEqual((yield* call("/nope", { sessionId: main })).status, 404)
      // The main agent moved to Pi under the same session id: the old Claude process neither polls nor renames the
      // conversation, and Pi (which subscribes) has no poll either.
      const key = (yield* db.projectKey(projectId))!
      yield* db.coordinatorLaunch(key, "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* db.noteHarnessSession(main, "pi-conversation")
      const old = yield* call("/inbox/poll", { sessionId: main, harnessSessionId: "claude-conversation" })
      assert.strictEqual(old.status, 403)
      assert.strictEqual((yield* db.coordinatorOf(projectId))?.harnessSessionId, "pi-conversation")
      assert.strictEqual((yield* call("/inbox/poll", { sessionId: main, harness: "pi" })).status, 403)
    }),
  )

  test(
    "the harness's conversation id and the plugin version are recorded in the row when they change, for the main agent and a subagent alike",
    Effect.gen(function* () {
      const { call, db, main, worker, projectId } = yield* project
      const conversation = (id: string) =>
        id === main
          ? Effect.map(db.coordinatorOf(projectId), (m) => m?.harnessSessionId)
          : Effect.map(db.getSession(id), (s) => s?.harnessSessionId)
      for (const id of [main, worker]) {
        yield* call("/inbox/ack", { sessionId: id, harnessSessionId: "c1" }, JSON.stringify({ ids: [] }))
        assert.strictEqual(yield* conversation(id), "c1")
        // The same id again: the row already holds it, nothing is written.
        assert.isFalse(yield* db.noteHarnessSession(id, "c1"))
        // After /clear the plugin sends the new id: the latest wins.
        yield* call("/inbox/ack", { sessionId: id, harnessSessionId: "c2" }, JSON.stringify({ ids: [] }))
        assert.strictEqual(yield* conversation(id), "c2")
        // The plugin version lives in the session's row (no per-session state in vibestd's memory).
        yield* call("/inbox/ack", { sessionId: id, pluginVersion: "1.2.3" }, JSON.stringify({ ids: [] }))
        assert.isFalse(yield* db.noteIntegration(id, { version: "1.2.3", protocol: PROTOCOL }))
        assert.isTrue(yield* db.noteIntegration(id, { version: "1.2.4", protocol: PROTOCOL }))
      }
    }),
  )

  test(
    "the integration version and protocol are recorded per session, also on a protocol mismatch",
    Effect.gen(function* () {
      const { call, db, main, worker, projectId } = yield* project
      const integration = (id: string) =>
        id === main
          ? Effect.map(db.coordinatorOf(projectId), (m) => m?.integration)
          : Effect.map(db.getSession(id), (s) => s?.metadata.integration)
      for (const id of [main, worker]) {
        assert.isUndefined(yield* integration(id))
        yield* call("/inbox/ack", { sessionId: id, pluginVersion: "1.0.0" }, JSON.stringify({ ids: [] }))
        assert.deepStrictEqual(yield* integration(id), { version: "1.0.0", protocol: PROTOCOL })
        // Refused for its protocol, still recorded: vibest update finds it on the old integration.
        const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "0.9.0" }), "vibest-protocol": "1" }
        const handle = yield* Http.make
        assert.strictEqual(
          (yield* handle({ path: "/inbox/poll", headers: Headers.fromInput(old), body: "{}" })).status,
          409,
        )
        assert.deepStrictEqual(yield* integration(id), { version: "0.9.0", protocol: 1 })
      }
      // A subagent's other metadata survives a later row write.
      yield* db.updateSession(worker, { lastActive: 1 })
      assert.deepStrictEqual(yield* integration(worker), { version: "0.9.0", protocol: 1 })
    }),
  )

  test(
    "poll hands a batch out once, each row leased; ack delivers it; an expired lease hands it out again",
    Effect.gen(function* () {
      const { call, db, inbox, main, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "hello", details: {} })
      const first = (yield* call("/inbox/poll", { sessionId: main })).body as Http.Reply["body"] & {
        ids: Array<number>
        line: string
        text: string
      }
      assert.lengthOf(first.ids, 1)
      assert.strictEqual(first.line, `General Agent "Fix the guard" sent a message (${worker})`)
      assert.strictEqual(first.text, "hello")
      assert.strictEqual(yield* statusOf(db, worker), "sending")
      // The lease is in sqlite: the row `sending`, its end in the main agent's session metadata.
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
      yield* TestClock.adjust(LEASE)
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, first.ids)
      const acked = yield* call("/inbox/ack", { sessionId: main }, JSON.stringify({ ids: first.ids }))
      assert.deepStrictEqual(acked, { status: 200, body: { acked: first.ids } })
      assert.strictEqual(yield* statusOf(db, worker), "delivered")
      // Again: harmless, nothing changes.
      assert.deepStrictEqual(yield* inbox.ack(projectId, first.ids), [])
      assert.strictEqual((yield* call("/inbox/ack", { sessionId: main }, "{}")).status, 400)
    }),
  )

  test(
    "each row keeps its own lease: a newer batch does not renew an older one that nobody acked",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      // Polls every second, as the plugin does, so the away check never fires.
      const wait = (seconds: number) =>
        Effect.gen(function* () {
          for (let i = 0; i < seconds; i++) {
            yield* TestClock.adjust("1 second")
            assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
          }
        })
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "old", details: {} })
      const old = yield* inbox.poll(projectId)
      yield* wait(20)
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "new", details: {} })
      const newer = yield* inbox.poll(projectId)
      assert.notDeepEqual(newer.ids, old.ids)
      yield* wait(9)
      // 30 s after it went out the old row is handed out again; the newer one is still leased.
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, old.ids)
      // Taken and given back in one ack: the old one delivered, the new one pending for the next poll.
      assert.deepStrictEqual(yield* inbox.ack(projectId, old.ids, newer.ids), old.ids)
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, newer.ids)
      assert.strictEqual(yield* statusOf(db, worker), "sending")
    }),
  )

  test(
    "a vibestd restart puts a polling main agent's handed-out rows back to pending",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "hello", details: {} })
      const { ids } = yield* inbox.poll(projectId)
      yield* db.recoverSending(["claude"])
      assert.strictEqual(yield* statusOf(db, worker), "pending")
      // The next poll hands the row out again at once.
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, ids)
      // A harness that does not poll: a cut-off delivery may have arrived, so it failed.
      yield* db.recoverSending([])
      assert.strictEqual(yield* statusOf(db, worker), "failed")
    }),
  )

  test(
    "a plugin that stopped polling: its lease goes back to pending after AWAY; an ack of a pending row still counts",
    Effect.gen(function* () {
      const { db, inbox, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "hello", details: {} })
      const { ids } = yield* inbox.poll(projectId)
      assert.strictEqual(yield* statusOf(db, worker), "sending")
      yield* TestClock.adjust(AWAY)
      yield* TestClock.adjust("2 seconds")
      yield* until(statusOf(db, worker), (s) => s === "pending")
      // Its prompt went in before it left: the ack it sends when it is back still delivers.
      assert.deepStrictEqual(yield* inbox.ack(projectId, ids), ids)
      assert.strictEqual(yield* statusOf(db, worker), "delivered")
      // Another project's main agent cannot ack this one's rows.
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "again", details: {} })
      const next = yield* inbox.poll(projectId)
      assert.deepStrictEqual(yield* inbox.ack(projectId + 1, next.ids), [])
    }),
  )

  test(
    "the prompt hook writes its start line at once, while the session's lock is held, with the round's stamp",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      yield* until(db.getSession(worker), (s) => s?.turnState === "open")
      // A check parked inside the runtime holds the lock, as a send's confirm loop does for up to 24 s.
      const held = yield* herdr.hold("state", worker)
      const checking = yield* Effect.forkChild(sessions.check(worker))
      yield* held.reached
      yield* TestClock.adjust("3 seconds")
      const stamp = yield* Clock.currentTimeMillis
      const hook = yield* Effect.forkChild(
        call(
          "/hooks/claude/prompt",
          { sessionId: worker },
          JSON.stringify({ hook_event_name: "PromptSubmit", text: "do it", origin: "composer" }),
        ),
      )
      const start = yield* until(
        fs.readFileString(layout.reportFile(worker)).pipe(Effect.orElseSucceed(() => "")),
        (text) => text.includes('"turn":"start"'),
      )
      assert.include(start, `"ts":${stamp}`)
      yield* held.release()
      yield* Fiber.join(checking)
      assert.strictEqual((yield* Fiber.join(hook)).status, 204)
    }),
  )

  test(
    "turn-end, prompt and guard hooks: the result file and report lines are vibestd's to write",
    Effect.gen(function* () {
      const { call, db, worker, main } = yield* project
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const prompt = yield* call(
        "/hooks/claude/prompt",
        { sessionId: worker },
        JSON.stringify({ hook_event_name: "PromptSubmit", text: "next step", origin: "composer" }),
      )
      assert.strictEqual(prompt.status, 204)
      assert.include(yield* fs.readFileString(layout.reportFile(worker)), '"prompt":"next step"')
      const end = yield* call(
        "/hooks/claude/turn-end",
        { sessionId: worker },
        JSON.stringify({
          hook_event_name: "TurnComplete",
          reason: "answer",
          last_assistant_message: "Fixed the guard.",
        }),
      )
      assert.strictEqual(end.status, 204)
      assert.include(yield* fs.readFileString(layout.resultFile(worker)), "Fixed the guard.")
      // The main agent's turn end is no result.
      yield* call(
        "/hooks/claude/turn-end",
        { sessionId: main },
        JSON.stringify({ hook_event_name: "TurnComplete", reason: "answer", last_assistant_message: "x" }),
      )
      assert.isFalse(yield* fs.exists(layout.resultFile(main)))
      // The guard applies the session's own rules: a subagent may not touch another session's scratch...
      const key = yield* db.projectKey((yield* db.getSession(worker))!.projectId)
      const tool = (file: string) =>
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "x" }, cwd: "/tmp" })
      const other = yield* call("/hooks/claude/guard", { sessionId: worker }, tool(`${layout.projects}/elsewhere/x`))
      assert.isString((other.body as { deny?: string }).deny)
      // ...but its own scratch is its to use, as VIBEST_SCRATCH in its terminal says.
      const own = yield* call("/hooks/claude/guard", { sessionId: worker }, tool(`${layout.scratch(key!)}/notes.md`))
      assert.deepStrictEqual(own, { status: 200, body: {} })
      // The main agent edits nothing.
      const coordinator = yield* call("/hooks/claude/guard", { sessionId: main }, tool("/tmp/x"))
      assert.isString((coordinator.body as { deny?: string }).deny)
      const bad = yield* call("/hooks/claude/guard", { sessionId: worker }, "not json")
      assert.isString((bad.body as { deny?: string }).deny)
    }),
  )

  test(
    "a turn end that names its turn is recorded once, however often the plugin sends it",
    Effect.gen(function* () {
      const { call, worker } = yield* project
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const end = (turn: string, text: string) =>
        call(
          "/hooks/claude/turn-end",
          { sessionId: worker },
          JSON.stringify({
            hook_event_name: "TurnComplete",
            turn_id: turn,
            reason: "answer",
            last_assistant_message: text,
          }),
        )
      assert.strictEqual((yield* end("t1", "first")).status, 204)
      const written = yield* fs.readFileString(layout.resultFile(worker))
      // Sent again (its answer was lost, or a reload sent what it kept): taken, nothing written.
      assert.strictEqual((yield* end("t1", "first")).status, 204)
      assert.strictEqual(yield* fs.readFileString(layout.resultFile(worker)), written)
      const ends = () =>
        fs
          .readFileString(layout.reportFile(worker))
          .pipe(Effect.map((t) => t.split("\n").filter((l) => l.includes('"turn":"end"')).length))
      assert.strictEqual(yield* ends(), 1)
      assert.strictEqual((yield* end("t2", "second")).status, 204)
      assert.include(yield* fs.readFileString(layout.resultFile(worker)), "second")
      assert.strictEqual(yield* ends(), 2)
    }),
  )

  test(
    "the ready report: an integration loaded from the plugin directory vibestd syncs reloads, any other does not",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      const layout = yield* Layout
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(layout.harnessPlugin("claude"), { recursive: true })
      const ready = (body: object) => call("/session/ready", { sessionId: worker }, JSON.stringify(body))
      assert.strictEqual((yield* ready({ pid: 4242, plugin: layout.harnessPlugin("claude") })).status, 204)
      assert.isTrue((yield* db.getSession(worker))!.metadata.reloads)
      assert.strictEqual((yield* db.getSession(worker))!.metadata.pid, 4242)
      // An install's own directory (an agent started before the sync), or a module that does not say.
      yield* ready({ pid: 4242, plugin: "/somewhere/harnesses/claude" })
      assert.isUndefined((yield* db.getSession(worker))!.metadata.reloads)
      yield* ready({ plugin: layout.harnessPlugin("claude") })
      yield* ready({ pid: 4242 })
      assert.isUndefined((yield* db.getSession(worker))!.metadata.reloads)
    }),
  )

  it.effect("served on a unix socket", () =>
    Effect.gen(function* () {
      const { main, projectId } = yield* project
      const layout = yield* Layout
      yield* Layer.launch(Http.layer.pipe(Layer.provide(Platform.daemon.httpServer(layout.httpSocket)))).pipe(
        Effect.forkScoped,
      )
      const response = yield* TestClock.withLive(
        Effect.promise(async () => {
          for (let i = 0; i < 100; i++) {
            try {
              return await fetch("http://vibestd/inbox/poll", {
                method: "POST",
                unix: layout.httpSocket,
                headers: sessionHeaders({ sessionId: main, projectId: String(projectId), harness: "claude" }),
                body: "{}",
              } as RequestInit)
            } catch {
              await new Promise((r) => setTimeout(r, 20))
            }
          }
          throw new Error("never served")
        }),
      )
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        ids: [],
        line: "",
        text: "",
      })
    }).pipe(Effect.provide(testLayer())),
  )
})
