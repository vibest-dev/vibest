// Orchestration modes composed from configuration and plugins only (N: reply routing is data). Each test is one mode
// from architecture.md's table, on the fake runtime and a fake model: peers, a human with several agents, a pipeline,
// a reviewer loop, and a plugin that forwards a result.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { sessionHeaders } from "@vibest/protocol/protocol"
import * as Server from "@vibest/server/server"
import { Effect, Layer, type Scope } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { authed, FakeRuntime, makeRepository, testLayer, type TestServices, until, writeResult } from "./fakes.ts"

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

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer({ plugins: [peers, forwarding] })),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)), 60_000)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
const asSession = (sessionId: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(yield* client, sessionHeaders({ sessionId, projectId: row && String(row.projectId) }))
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
const answer = (id: string, text: string) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    yield* writeResult(id, "pi", { text })
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
})
