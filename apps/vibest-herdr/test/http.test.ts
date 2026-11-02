// vibestd's HTTP API (packages/server/src/http.ts) and the poll / ack delivery under it (core/inbox.ts), over the fake
// runtime. The handler is called directly; one test serves it on a real unix socket.
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { AWAY, Inbox, LEASE, line, LINE_MAX } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { repositoryKey } from "@vibest/core/worktree"
import { PROTOCOL, sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import type { InboxRow } from "@vibest/schema/session"
import * as Http from "@vibest/server/http"
import { Effect, FileSystem, Layer, type Scope } from "effect"
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
      line([row({ sessionId: "95603b88", details: { status: "needs_input" } })], reviewer),
      'Reviewer Agent "Review the guard fix" needs input (95603b88)',
    )
    assert.strictEqual(
      line([row({ kind: "report" })], who),
      'General Agent "Fix guard scratch rule" sent a message (349f65b2)',
    )
    const status = (details: Record<string, unknown>) => line([row({ details })], who).split('" ')[1]
    assert.strictEqual(status({ status: "failed" }), "failed (349f65b2)")
    assert.strictEqual(status({ status: "completed", error: "the turn ended on an API error" }), "failed (349f65b2)")
    assert.strictEqual(status({ status: "unknown", error: "interrupted" }), "was interrupted (349f65b2)")
    assert.strictEqual(status({ status: "unknown" }), "ended without a status (349f65b2)")
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
    handle({ path, headers: Headers.fromInput(sessionHeaders({ projectId: String(projectId), ...who })), body })
  return { db, herdr, main: main.sessionId, worker, projectId, call, inbox: yield* Inbox }
})

const statusOf = (db: Db["Service"], worker: string) =>
  db.latestInbox(worker, "report").pipe(Effect.map((r) => r?.status))

describe("vibestd's HTTP API", () => {
  test(
    "the caller is checked: protocol 409, unknown session 404, missing or other project 403, a subagent's poll 403",
    Effect.gen(function* () {
      const { call, main, worker } = yield* project
      const handle = yield* Http.make
      const raw = (headers: Record<string, string>) =>
        handle({ path: "/v1/inbox/poll", headers: Headers.fromInput(headers), body: "{}" })
      const own = sessionHeaders({ sessionId: main })
      assert.strictEqual((yield* raw({ ...own, "vibest-protocol": String(PROTOCOL - 1) })).status, 409)
      assert.strictEqual((yield* call("/v1/inbox/poll", { sessionId: "nosuch00" })).status, 404)
      // Missing project id: refused while Http.MISSING_PROJECT_ID says so.
      assert.strictEqual(Http.MISSING_PROJECT_ID, "refuse")
      assert.strictEqual((yield* raw(own)).status, 403)
      assert.strictEqual((yield* call("/v1/inbox/poll", { sessionId: main, projectId: "999" })).status, 403)
      assert.strictEqual((yield* call("/v1/inbox/poll", { sessionId: worker })).status, 403)
      assert.strictEqual((yield* call("/v1/inbox/poll", { sessionId: main })).status, 200)
      assert.strictEqual((yield* call("/v1/nope", { sessionId: main })).status, 404)
    }),
  )

  test(
    "the harness's conversation id is recorded when it changes, for the main agent and a subagent alike",
    Effect.gen(function* () {
      const { call, db, main, worker, projectId } = yield* project
      const conversation = (id: string) =>
        id === main
          ? Effect.map(db.coordinatorOf(projectId), (m) => m?.harnessSessionId)
          : Effect.map(db.getSession(id), (s) => s?.harnessSessionId)
      for (const id of [main, worker]) {
        yield* call("/v1/inbox/ack", { sessionId: id, harnessSessionId: "c1" }, JSON.stringify({ ids: [] }))
        assert.strictEqual(yield* conversation(id), "c1")
        // Written by someone else meanwhile: an unchanged header does not write again.
        yield* db.noteHarnessSession(id, "other")
        yield* call("/v1/inbox/ack", { sessionId: id, harnessSessionId: "c1" }, JSON.stringify({ ids: [] }))
        assert.strictEqual(yield* conversation(id), "other")
        // After /clear the plugin sends the new id: the latest wins.
        yield* call("/v1/inbox/ack", { sessionId: id, harnessSessionId: "c2" }, JSON.stringify({ ids: [] }))
        assert.strictEqual(yield* conversation(id), "c2")
      }
    }),
  )

  test(
    "poll hands a batch out once, leased; ack delivers it; an expired lease hands it out again",
    Effect.gen(function* () {
      const { call, db, inbox, main, worker, projectId } = yield* project
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "hello", details: {} })
      const first = (yield* call("/v1/inbox/poll", { sessionId: main })).body as Http.Reply["body"] & {
        ids: Array<number>
        line: string
        text: string
      }
      assert.lengthOf(first.ids, 1)
      assert.strictEqual(first.line, `General Agent "Fix the guard" sent a message (${worker})`)
      assert.strictEqual(first.text, "hello")
      assert.strictEqual(yield* statusOf(db, worker), "sending")
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
      yield* TestClock.adjust(LEASE)
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, first.ids)
      const acked = yield* call("/v1/inbox/ack", { sessionId: main }, JSON.stringify({ ids: first.ids }))
      assert.deepStrictEqual(acked, { status: 200, body: { acked: first.ids } })
      assert.strictEqual(yield* statusOf(db, worker), "delivered")
      // Again: harmless, nothing changes.
      assert.deepStrictEqual(yield* inbox.ack(projectId, first.ids), [])
      assert.strictEqual((yield* call("/v1/inbox/ack", { sessionId: main }, "{}")).status, 400)
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
    "turn-end, prompt and guard hooks: the result file and report lines are vibestd's to write",
    Effect.gen(function* () {
      const { call, db, worker, main } = yield* project
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const prompt = yield* call(
        "/v1/hooks/claude/prompt",
        { sessionId: worker },
        JSON.stringify({ hook_event_name: "PromptSubmit", text: "next step", origin: "composer" }),
      )
      assert.strictEqual(prompt.status, 204)
      assert.include(yield* fs.readFileString(layout.reportFile(worker)), '"prompt":"next step"')
      const end = yield* call(
        "/v1/hooks/claude/turn-end",
        { sessionId: worker },
        JSON.stringify({
          hook_event_name: "TurnComplete",
          reason: "answer",
          last_assistant_message: "status: completed",
        }),
      )
      assert.strictEqual(end.status, 204)
      assert.include(yield* fs.readFileString(layout.resultFile(worker)), "status: completed")
      // The main agent's turn end is no result.
      yield* call(
        "/v1/hooks/claude/turn-end",
        { sessionId: main },
        JSON.stringify({ hook_event_name: "TurnComplete", reason: "answer", last_assistant_message: "x" }),
      )
      assert.isFalse(yield* fs.exists(layout.resultFile(main)))
      // The guard applies the session's own rules: a subagent may not touch another session's scratch...
      const key = yield* db.projectKey((yield* db.getSession(worker))!.projectId)
      const tool = (file: string) =>
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "x" }, cwd: "/tmp" })
      const other = yield* call("/v1/hooks/claude/guard", { sessionId: worker }, tool(`${layout.projects}/elsewhere/x`))
      assert.isString((other.body as { deny?: string }).deny)
      // ...but its own scratch is its to use, as VIBEST_SCRATCH in its terminal says.
      const own = yield* call("/v1/hooks/claude/guard", { sessionId: worker }, tool(`${layout.scratch(key!)}/notes.md`))
      assert.deepStrictEqual(own, { status: 200, body: {} })
      // The main agent edits nothing.
      const coordinator = yield* call("/v1/hooks/claude/guard", { sessionId: main }, tool("/tmp/x"))
      assert.isString((coordinator.body as { deny?: string }).deny)
      const bad = yield* call("/v1/hooks/claude/guard", { sessionId: worker }, "not json")
      assert.isString((bad.body as { deny?: string }).deny)
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
              return await fetch("http://vibestd/v1/inbox/poll", {
                method: "POST",
                unix: layout.httpSocket,
                headers: sessionHeaders({ sessionId: main, projectId: String(projectId) }),
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
