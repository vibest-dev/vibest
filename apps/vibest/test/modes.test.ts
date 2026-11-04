// Orchestration modes composed from configuration and plugins only (N: reply routing is data). Each test is one mode
// from architecture.md's table, on the fake runtime and a fake model: peers, a human with several agents, a pipeline,
// a reviewer loop, and a plugin that forwards a result.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Actions } from "@vibest/core/actions"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { sessionHeaders } from "@vibest/protocol/protocol"
import * as Server from "@vibest/server/server"
import { Project } from "@vibest/vibest/project"
import { Effect, Layer, type Scope } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  testLayer,
  type TestServices,
  until,
  writeResult,
  projectNumber,
} from "./fakes.ts"

/** A peer messages any session of its project and spawns none. */
const peers = Plugin.define({
  id: "peers",
  effect: (context) => context.agent.define({ name: "peer", tools: "full", can: { spawn: false, message: "project" } }),
})

/** Forwards a result whose text says `forward to <id>` to that session instead of where vibest routed it. */
const forwarding = Plugin.define({
  id: "forwarding",
  effect: (context) =>
    context.agent.hook("result", (event) =>
      Effect.sync(() => {
        const match = /forward to (\w{8})/.exec(event.output)
        if (match) event.recipients = [match[1]!]
      }),
    ),
})

/** Copies a result whose text says `copy to <id> <id>` to both sessions. */
const copying = Plugin.define({
  id: "copying",
  effect: (context) =>
    context.agent.hook("result", (event) =>
      Effect.sync(() => {
        const match = /copy to (\w{8}) (\w{8})/.exec(event.output)
        if (match) event.recipients = [match[1]!, match[2]!]
      }),
    ),
})

/** Notices of a session waiting on the person go to the user, reworded; the rest as vibest routes them. */
const noticePolicy = Plugin.define({
  id: "notice-policy",
  effect: (context) =>
    context.agent.hook("notice", (event) =>
      Effect.sync(() => {
        if (event.kind !== "blocked") return
        event.recipients = [null]
        event.text = `[${event.agentType}] ${event.text}`
      }),
    ),
})

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer({ plugins: [peers, forwarding, copying, noticePolicy] })),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)), 60_000)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
const asSession = (sessionId: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(
      yield* client,
      sessionHeaders({ sessionId, projectId: row && String(yield* projectNumber(row.scope)) }),
    )
  })

/** Every result row of `about`: who it went to (null: the user) and its status, oldest first. */
const resultsOf = (about: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ recipient: string | null; status: string }>`SELECT i.recipient_session_id AS recipient,
      i.status FROM inbox i JOIN event e ON e.id = i.result_event_id WHERE i.kind = 'result' AND e.session_id = ${about}
      ORDER BY i.id`
  })

/** End `id`'s open turn with `text` (what its harness answered) and let vibestd collect it. */
const answer = (id: string, text: string, harness: "pi" | "cursor" = "pi") =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    yield* writeResult(id, harness, { text })
    yield* herdr.endTurn(id)
    yield* (yield* Sessions).check(id)
    yield* until((yield* Db).getSession(id), (s) => s?.turnState !== "open")
  })

/** `id` takes what is queued for it (it is idle), and its turn on it opens. */
const takes = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Sessions).check(id)
    yield* until((yield* Db).getSession(id), (s) => s?.turnState === "open")
  })

const opened = (id: string) => Effect.flatMap(Db, (db) => until(db.getSession(id), (s) => s?.turnState === "open"))

describe("orchestration modes", () => {
  test(
    "a human with two peers: their results wait in the user's inbox; a peer's send is answered to it, and its turn on that answer answers no one",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id: a } = yield* user.Spawn({ harness: "pi", agent: "peer", prompt: "write the parser" })
      const { id: b } = yield* user.Spawn({ harness: "pi", agent: "peer", prompt: "write the tests" })
      yield* opened(a)
      yield* opened(b)

      // No main agent: each result is the user's, read once with `vibest inbox`.
      yield* answer(a, "parser done")
      yield* answer(b, "tests done")
      const inbox = yield* user["Inbox.Read"]({})
      assert.deepStrictEqual(
        inbox.map((r) => r.from),
        [a, b],
      )
      assert.include(inbox[0]!.message, "parser done")
      assert.deepStrictEqual(yield* user["Inbox.Read"]({}), [])

      // A asks B; B's answer goes to A, not to the user.
      yield* (yield* asSession(a)).Send({ id: b, message: "do the tests cover empty input?" })
      yield* opened(b)
      yield* answer(b, "yes, they do")
      assert.deepStrictEqual(
        (yield* resultsOf(b)).map((r) => r.recipient),
        [null, a],
      )
      // A's turn on that answer goes to no one (kept as A's own, dropped): a result never starts a result.
      yield* takes(a)
      yield* answer(a, "thanks")
      const last = (yield* resultsOf(a)).at(-1)!
      assert.deepStrictEqual(last, { recipient: a, status: "dropped" })
      assert.deepStrictEqual(yield* user["Inbox.Read"]({}), [])
    }),
  )

  test(
    "a pipeline: --report-to sends a stage's result to the next stage, whose turn on it starts",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id: review } = yield* user.Spawn({ harness: "pi", prompt: "review what arrives" })
      yield* opened(review)
      yield* answer(review, "ready")
      const { id: build } = yield* user.Spawn({ harness: "pi", prompt: "build it", reportTo: review })
      yield* opened(build)
      yield* answer(build, "built: commit abc")
      assert.deepStrictEqual(
        (yield* resultsOf(build)).map((r) => r.recipient),
        [review],
      )
      yield* takes(review)
    }),
  )

  test(
    "a reviewer loop: the implementer reports to the reviewer, the reviewer's send comes back answered to it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id: reviewer } = yield* user.Spawn({ harness: "pi", agent: "peer", prompt: "review the implementer" })
      yield* opened(reviewer)
      yield* answer(reviewer, "waiting")
      const { id: impl } = yield* user.Spawn({ harness: "pi", prompt: "implement it", reportTo: reviewer })
      yield* opened(impl)
      yield* answer(impl, "first version")
      yield* takes(reviewer)
      yield* (yield* asSession(reviewer)).Send({ id: impl, message: "handle the error case" })
      yield* answer(reviewer, "asked for a fix")
      yield* opened(impl)
      yield* answer(impl, "second version")
      assert.deepStrictEqual(
        (yield* resultsOf(impl)).map((r) => r.recipient),
        [reviewer, reviewer],
      )
    }),
  )

  test(
    "agent.result: a plugin forwards a result to another session",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id: target } = yield* user.Spawn({ harness: "pi", prompt: "collect" })
      yield* opened(target)
      const { id: source } = yield* user.Spawn({ harness: "pi", prompt: "work" })
      yield* opened(source)
      yield* answer(source, `done; forward to ${target}`)
      assert.deepStrictEqual(
        (yield* resultsOf(source)).map((r) => r.recipient),
        [target],
      )
    }),
  )

  test(
    "a result to two sessions: every recipient row is delivered at once, each typed into its idle session without waiting for a check",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const herdr = yield* FakeRuntime
      const { id: x } = yield* user.Spawn({ harness: "cursor", prompt: "collect one" })
      const { id: y } = yield* user.Spawn({ harness: "cursor", prompt: "collect two" })
      yield* opened(x)
      yield* opened(y)
      yield* answer(x, "ready", "cursor")
      yield* answer(y, "ready", "cursor")
      const { id: source } = yield* user.Spawn({ harness: "pi", prompt: "work" })
      yield* opened(source)
      yield* answer(source, `done; copy to ${x} ${y}`)
      assert.deepStrictEqual(
        (yield* resultsOf(source)).map((r) => r.recipient),
        [x, y],
      )
      // No check of x or y: the turn end hands both their row.
      yield* opened(x)
      yield* opened(y)
      const typed = (yield* herdr.callsTo("send")).filter((c) => c.text?.includes("done; copy to"))
      assert.lengthOf(typed, 2)
      assert.deepStrictEqual(
        (yield* resultsOf(source)).map((r) => r.status),
        ["delivered", "delivered"],
      )
    }),
  )

  test(
    "agent.notice: a plugin sends a blocked session's notice to the user, reworded; other notices keep vibest's route",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const sessions = yield* Sessions
      const { id: lead } = yield* user.Spawn({ harness: "pi", agent: "peer", prompt: "lead" })
      yield* opened(lead)
      yield* answer(lead, "ready")
      const { id: worker } = yield* user.Spawn({ harness: "pi", prompt: "work", reportTo: lead })
      yield* opened(worker)
      yield* sessions.activity(worker, { blocked: "permission" })
      // The user's inbox holds the lead's own result (no main agent) and the worker's notice.
      const notice = (yield* until(user["Inbox.Read"]({}), (rows) => rows.some((r) => r.from === worker))).find(
        (r) => r.from === worker,
      )!
      assert.match(notice.message, /^\[general\] .* has been waiting for a permission decision/)
      // Nothing of it reached the lead.
      const sql = yield* SqlClient.SqlClient
      const toLead = yield* sql<{ n: number }>`SELECT count(*) AS n FROM inbox WHERE kind = 'notice'
        AND recipient_session_id = ${lead}`
      assert.strictEqual(toLead[0]!.n, 0)
    }),
  )

  test(
    "pushing to the user: a session's vibest report --user and a plugin's notice to the user land in the user's inbox, though a coordinator would take its other rows",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id } = yield* user.Spawn({ harness: "pi", agent: "peer", prompt: "watch the build" })
      yield* opened(id)
      yield* (yield* asSession(id)).Report({ message: "the build is red", user: true })
      yield* (yield* Actions).notice({ about: id, kind: "message", text: "nightly report ready", to: [null] })
      const rows = yield* until(user["Inbox.Read"]({}), (r) => r.length === 2)
      assert.deepStrictEqual(
        rows.map((r) => [r.from, r.kind]),
        [
          [id, "notice"],
          [id, "notice"],
        ],
      )
      assert.include(rows[0]!.message, "the build is red")
      assert.strictEqual(rows[1]!.message, "nightly report ready")
    }),
  )
})
