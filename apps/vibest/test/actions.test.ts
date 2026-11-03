// Plugins acting as a session (`context.session.send` / `spawn`), bounded by what that session itself may do. Each
// test is one orchestration a plugin builds on it, on the fake runtime and a fake model: fan-out with a gather, a
// timer, a swarm handoff to an agent that does not run yet, and a team reached by a group address.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import * as Server from "@vibest/server/server"
import { Project } from "@vibest/vibest/project"
import { Effect, Layer, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { authed, FakeRuntime, makeRepository, testLayer, type TestServices, until, writeResult } from "./fakes.ts"

/** What the plugins below were refused, for the tests to read. */
const refusals: Array<string> = []
const note = (e: { readonly reason: string }) => Effect.sync(() => void refusals.push(e.reason))

/**
 * Fan-out and gather: a lead whose result says `fan out: a; b; c` starts one worker per part as itself; their results
 * reach no one alone, and once all are in the lead gets them as one message, sent as itself.
 */
const gather = Plugin.define({
  id: "gather",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      yield* context.agent.define({ name: "lead", tools: "full", can: { spawn: true, message: "project" } })
      const groups = new Map<
        string,
        { readonly lead: string; readonly parts: number; readonly outputs: Map<string, string> }
      >()
      yield* context.agent.hook("result", (event) =>
        Effect.gen(function* () {
          const fan = /^fan out: (.+)$/m.exec(event.output)
          if (fan && event.agentType === "lead") {
            const parts = fan[1]!.split(";").map((p) => p.trim())
            const group = { lead: event.sessionId, parts: parts.length, outputs: new Map<string, string>() }
            event.recipients = []
            yield* Effect.forkIn(
              Effect.forEach(parts, (prompt) =>
                context.session
                  .spawn({ as: event.sessionId, prompt, harness: "pi" })
                  .pipe(Effect.tap(({ id }) => Effect.sync(() => void groups.set(id, group)))),
              ).pipe(Effect.catchTag("ActionRefused", note)),
              scope,
            )
            return
          }
          const group = groups.get(event.sessionId)
          if (!group) return
          group.outputs.set(event.sessionId, event.output)
          event.recipients = []
          if (group.outputs.size < group.parts) return
          const message = `gathered:\n${[...group.outputs.values()].join("\n")}`
          yield* Effect.forkIn(
            context.session
              .send({ as: group.lead, to: group.lead, message })
              .pipe(Effect.catchTag("ActionRefused", note)),
            scope,
          )
        }),
      )
    }),
})

/** A timer: a result saying `remind me in N minutes: <text>` has whoever it reports to send `<text>` back N minutes later. */
const timer = Plugin.define({
  id: "timer",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      yield* context.agent.hook("result", (event) =>
        Effect.gen(function* () {
          const m = /remind me in (\d+) minutes: (.+)/.exec(event.output)
          const as = event.recipients[0]
          if (!m || typeof as !== "string") return
          yield* Effect.forkIn(
            Effect.sleep(`${Number(m[1])} minutes`).pipe(
              Effect.andThen(context.session.send({ as, to: event.sessionId, message: m[2]! })),
              Effect.catchTag("ActionRefused", note),
            ),
            scope,
          )
        }),
      )
    }),
})

/**
 * A swarm handoff: a result saying `handoff: <task>` starts the next agent on it, and the result itself reaches no
 * one. The worker may not start sessions, so the plugin hands off as whoever the result was going to.
 */
const handoff = Plugin.define({
  id: "handoff",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      yield* context.agent.hook("result", (event) =>
        Effect.gen(function* () {
          const m = /^handoff: (.+)$/m.exec(event.output)
          const to = event.recipients[0]
          if (!m || typeof to !== "string") return
          event.recipients = []
          const start = (as: string) =>
            context.session.spawn({
              as,
              prompt: `${m[1]!}\n\n(handed off by ${event.sessionId})`,
              harness: "pi",
              name: "next",
            })
          // As itself first: refused, a worker starts nothing.
          yield* Effect.forkIn(
            start(event.sessionId).pipe(
              Effect.catchTag("ActionRefused", (e) => note(e).pipe(Effect.andThen(start(to)))),
              Effect.catchTag("ActionRefused", note),
            ),
            scope,
          )
        }),
      )
    }),
})

/** Teams: a group address. A result saying `to @<team>: <text>` is sent as its session to every member of the team. */
const teams = new Map<string, ReadonlyArray<string>>()
const team = Plugin.define({
  id: "team",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      yield* context.agent.define({ name: "member", tools: "full", can: { spawn: false, message: "project" } })
      yield* context.agent.hook("result", (event) =>
        Effect.gen(function* () {
          const m = /^to @(\w+): (.+)$/m.exec(event.output)
          if (!m) return
          event.recipients = []
          const members = (teams.get(m[1]!) ?? []).filter((id) => id !== event.sessionId)
          yield* Effect.forkIn(
            Effect.forEach(members, (to) =>
              context.session
                .send({ as: event.sessionId, to, message: m[2]! })
                .pipe(Effect.catchTag("ActionRefused", note)),
            ),
            scope,
          )
        }),
      )
    }),
})

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer({ plugins: [gather, timer, handoff, team] })),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(
    name,
    () => Effect.sync(() => void (refusals.length = 0)).pipe(Effect.andThen(program), Effect.provide(served)),
    60_000,
  )

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

/** End `id`'s open turn with `text` and let vibestd collect it. */
const answer = (id: string, text: string) =>
  Effect.gen(function* () {
    yield* writeResult(id, "pi", { text })
    yield* (yield* FakeRuntime).endTurn(id)
    yield* (yield* Sessions).check(id)
    yield* until((yield* Db).getSession(id), (s) => s?.turnState !== "open")
  })

const opened = (id: string) => Effect.flatMap(Db, (db) => until(db.getSession(id), (s) => s?.turnState === "open"))

/** Every row addressed to `to`: kind, sender, status and text, oldest first. */
const inboxOf = (to: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ kind: string; sender: string | null; status: string; content: string }>`SELECT kind,
      sender_session_id AS sender, status, content FROM inbox WHERE recipient_session_id = ${to} ORDER BY id`
  })

/** Who `about`'s result rows went to (null: the user), oldest first. */
const resultsOf = (about: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql<{ recipient: string | null }>`SELECT i.recipient_session_id AS recipient FROM inbox i
      JOIN event e ON e.id = i.result_event_id WHERE i.kind = 'result' AND e.session_id = ${about} ORDER BY i.id`).map(
      (r) => r.recipient,
    )
  })

const childrenOf = (parent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql<{
      id: string
    }>`SELECT id FROM session WHERE parent_session_id = ${parent} ORDER BY created_at, id`).map((r) => r.id)
  })

describe("plugin actions", () => {
  test(
    "fan-out and gather: a lead's three workers, started by a plugin as the lead; their results come back to it as one message",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const { id: lead } = yield* user.Spawn({ harness: "pi", agent: "lead", prompt: "split the work" })
      yield* opened(lead)
      yield* answer(lead, "fan out: parse; check; print")
      const workers = yield* until(childrenOf(lead), (ids) => ids.length === 3)
      for (const [i, w] of workers.entries()) {
        yield* opened(w)
        yield* answer(w, `part ${i} done`)
      }
      // No worker's result reached anyone alone; the lead got one message from itself with all three.
      for (const w of workers) assert.deepStrictEqual(yield* resultsOf(w), [w])
      const rows = yield* until(inboxOf(lead), (r) => r.some((m) => m.kind === "send"))
      const sent = rows.filter((m) => m.kind === "send")
      assert.lengthOf(sent, 1)
      assert.strictEqual(sent[0]!.sender, lead)
      for (const i of [0, 1, 2]) assert.include(sent[0]!.content, `part ${i} done`)
      yield* opened(lead)
      assert.deepStrictEqual(refusals, [])
    }),
  )

  test(
    "a timer: five minutes after a worker asks, the main agent it reports to sends it the reminder, and its turn on it starts",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const main = yield* user["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
      const { id: worker } = yield* user.Spawn({ harness: "pi", prompt: "watch the build" })
      yield* opened(worker)
      yield* answer(worker, "started it; remind me in 5 minutes: check the CI run")
      assert.deepStrictEqual(yield* resultsOf(worker), [main.sessionId])
      yield* TestClock.adjust("4 minutes")
      assert.isFalse((yield* inboxOf(worker)).some((m) => m.kind === "send"))
      yield* TestClock.adjust("1 minute")
      const rows = yield* until(inboxOf(worker), (r) => r.some((m) => m.kind === "send"))
      assert.deepInclude(
        rows.find((m) => m.kind === "send")!,
        { sender: main.sessionId, content: "check the CI run" },
      )
      yield* opened(worker)
      assert.deepStrictEqual(refusals, [])
    }),
  )

  test(
    "a swarm handoff: a worker's result starts the next agent, which did not run before; a worker may not start it itself",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const main = yield* user["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
      const { id: worker } = yield* user.Spawn({ harness: "pi", prompt: "write the parser" })
      yield* opened(worker)
      yield* answer(worker, "parser written\nhandoff: write the parser's documentation")
      // The next agent is the main agent's child (the worker, started by the user, is no one's).
      const [next] = yield* until(childrenOf(main.sessionId), (ids) => ids.length === 1)
      // Refused as the worker (its definition starts nothing), done as the main agent its result was going to.
      assert.lengthOf(refusals, 1)
      assert.include(refusals[0]!, "may not call Spawn")
      const row = (yield* (yield* Db).getSession(next!))!
      assert.strictEqual(row.name, "next")
      yield* opened(next!)
      const task = (yield* inboxOf(next!)).find((m) => m.kind === "task")!
      assert.include(task.content, "write the parser's documentation")
      assert.include(task.content, `handed off by ${worker}`)
      // The handed-off result reached no one; the next agent's goes to the main agent that started it.
      assert.deepStrictEqual(yield* resultsOf(worker), [worker])
      yield* answer(next!, "docs written")
      assert.deepStrictEqual(yield* resultsOf(next!), [main.sessionId])
    }),
  )

  test(
    "teams: a message to a group address reaches every member, each answer goes back to the sender, and a worker may not use it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const user = authed(yield* client, cliHeaders(repo))
      const ids: Array<string> = []
      for (const prompt of ["lead the docs", "review", "proofread"]) {
        const { id } = yield* user.Spawn({ harness: "pi", agent: "member", prompt })
        yield* opened(id)
        ids.push(id)
      }
      const [a, b, c] = ids as [string, string, string]
      teams.set("docs", [a, b, c])
      yield* answer(b, "ready")
      yield* answer(c, "ready")
      yield* answer(a, "draft done\nto @docs: review the draft")
      for (const member of [b, c]) {
        // Taken into its turn (delivered), so that turn's answer is the sender's.
        const rows = yield* until(inboxOf(member), (r) => r.some((m) => m.kind === "send" && m.status === "delivered"))
        assert.deepInclude(
          rows.find((m) => m.kind === "send")!,
          { sender: a, content: "review the draft" },
        )
        yield* opened(member)
        yield* answer(member, `${member} reviewed`)
        assert.strictEqual((yield* resultsOf(member)).at(-1), a)
      }
      // A worker (report-only) addressing the team is refused for each member, and nothing is sent.
      const { id: worker } = yield* user.Spawn({ harness: "pi", prompt: "chat" })
      yield* opened(worker)
      teams.set("docs", [a, b, c, worker])
      yield* answer(worker, "to @docs: hello")
      yield* until(
        Effect.sync(() => refusals.length),
        (n) => n === 3,
      )
      for (const reason of refusals) assert.include(reason, "only reports to whoever started it")
      for (const member of [a, b, c]) assert.isFalse((yield* inboxOf(member)).some((m) => m.content === "hello"))
    }),
  )
})
