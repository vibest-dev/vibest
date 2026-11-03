// One kind of session, described by agent definitions (L): a plugin defines `lead` (it spawns, manages its children)
// with `context.agent.define`, and the engine lets it do exactly that over vibest.sock, with no main-agent branch.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { sessionHeaders } from "@vibest/protocol/protocol"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, FileSystem, Layer, Option, type Scope } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  writeResult,
} from "./fakes.ts"

const leads = Plugin.define({
  id: "leads",
  effect: (context) =>
    context.agent.define({
      name: "lead",
      tools: "full",
      can: { spawn: true, message: "children" },
      rules: "You lead a part of the work: split it, start sessions, gather their results.",
    }),
})

const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served({ plugins: [leads] }))), 30_000)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
const asSession = (sessionId: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(yield* client, sessionHeaders({ sessionId, projectId: row && String(row.projectId) }))
  })
const tagOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), { onNone: () => "defect", onSome: (e) => e._tag })
    : "success"

/** Who a result row about `about` is addressed to. */
const recipientsOf = (about: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ recipient: string | null }>`SELECT i.recipient_session_id AS recipient FROM inbox i
      JOIN event e ON e.id = i.result_event_id WHERE i.kind = 'result' AND e.session_id = ${about}`
    return rows.map((r) => r.recipient)
  })

describe("agent definitions", () => {
  test(
    "nested lead: the main agent starts a lead, the lead starts a worker beside it, the worker's result goes to the lead, and the lead manages only its own",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const launched = yield* user["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
      const main = yield* asSession(launched.sessionId)

      const { id: lead } = yield* main.Spawn({ harness: "pi", agent: "lead", prompt: "lead the parser work" })
      const { id: other } = yield* main.Spawn({ harness: "pi", prompt: "unrelated" })
      yield* until(db.getSession(lead), (s) => s?.turnState === "open")
      // Its rules say it may start sessions, and carry what its definition adds.
      const rules = yield* fs.readFileString(layout.rulesFile(lead))
      assert.include(rules, "You may start sessions of your own")
      assert.include(rules, "You lead a part of the work")

      const asLead = yield* asSession(lead)
      const { id: worker } = yield* asLead.Spawn({ harness: "pi", prompt: "write the tokenizer" })
      assert.strictEqual(yield* db.parentOf(worker), lead)
      // Its terminal is opened beside the lead's, not the main agent's.
      const leadTerminal = (yield* db.getSession(lead))!.address.id
      const opens = yield* until(herdr.callsTo("open"), (calls) =>
        calls.some((c) => c.env.VIBEST_SESSION_ID === worker),
      )
      assert.strictEqual(opens.find((c) => c.env.VIBEST_SESSION_ID === worker)?.near, leadTerminal)
      yield* until(db.getSession(worker), (s) => s?.turnState === "open")

      // The lead lists its project and manages its own worker, not a session it did not start.
      assert.isTrue((yield* asLead.List({})).some((s) => s.id === worker))
      assert.strictEqual(tagOf(yield* Effect.exit(asLead.Peek({ id: worker }))), "success")
      assert.strictEqual(tagOf(yield* Effect.exit(asLead.Send({ id: other, message: "x" }))), "Forbidden")
      assert.strictEqual(tagOf(yield* Effect.exit(asLead.Interrupt({ id: other }))), "Forbidden")

      // A worker (the default definition) spawns nothing and manages nothing.
      const asWorker = yield* asSession(worker)
      assert.strictEqual(tagOf(yield* Effect.exit(asWorker.Spawn({ harness: "pi", prompt: "more" }))), "Forbidden")
      assert.strictEqual(tagOf(yield* Effect.exit(asWorker.Send({ id: lead, message: "x" }))), "Forbidden")
      assert.strictEqual(tagOf(yield* Effect.exit(asWorker.List({}))), "Forbidden")

      // The worker's result is addressed to the lead; the lead's own result to the main agent.
      yield* writeResult(worker, "pi", { text: "tokenizer done" })
      yield* herdr.endTurn(worker)
      yield* (yield* Sessions).check(worker)
      yield* until(recipientsOf(worker), (r) => r.length === 1)
      assert.deepStrictEqual(yield* recipientsOf(worker), [lead])
      yield* writeResult(lead, "pi", { text: "parser done" })
      yield* herdr.endTurn(lead)
      yield* (yield* Sessions).check(lead)
      yield* until(recipientsOf(lead), (r) => r.length === 1)
      assert.deepStrictEqual(yield* recipientsOf(lead), [launched.sessionId])
      // The lead sends its worker a follow-up: accepted.
      assert.strictEqual(tagOf(yield* Effect.exit(asLead.Send({ id: worker, message: "add tests" }))), "success")
    }),
  )
})
