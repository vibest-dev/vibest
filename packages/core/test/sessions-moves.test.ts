import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { AgentRefused as PluginRefused, isLimited, Plugin } from "@vibest/plugin"
import { Effect, Fiber, HashMap, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { EXECUTIONS, until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import {
  harnessOf,
  spawnInput,
  spawnWorking,
  test,
  sqlNotices,
  limited,
  chooseNext,
  type FailSeen,
} from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "an explicit harness whose every login is limited still starts: no builtin refuses by quota",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const subs = yield* Subscriptions
      yield* subs.report({ harness: "pi", provider: "anthropic", limits: [limited] })
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      const started = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      assert.strictEqual(started.harness, "pi")
      yield* until(herdr.callsTo("open"), (calls) => calls.length > 0)
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.strictEqual((yield* db.listSessions()).length, 1)
    }),
  )

  test(
    "a set provider is kept, limited or not",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const subs = yield* Subscriptions
      const open = { window: "5h", percent: 0, status: "available" as const, resetTime: null }
      yield* subs.report({ harness: "pi", provider: "anthropic", limits: [limited] })
      yield* subs.report({ harness: "pi", provider: "openai", limits: [open] })
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const limitedOne = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "anthropic" })
      assert.strictEqual(limitedOne.provider, "anthropic")
      const fine = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai", name: "other" })
      yield* until(db.getSession(fine.id), (row) => !!row && row.startedAt !== null)
      yield* sessions.check(fine.id)
      assert.deepInclude(yield* db.getSession(fine.id), { harnessId: "pi", provider: "openai", executionState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "pi"],
      )
    }),
  )

  test(
    "an unconfirmed prompt after a limit tries the next harness in a new execution and is not remembered, so the next limit can use that harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const executionId = (yield* sql<{
        id: number
      }>`SELECT id FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id}`.pipe(Effect.orDie))[0]!.id
      yield* Ref.set(herdr.skipPromptUpdates, 2)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* untilVirtual(
        Effect.sync(() => checking.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      const row = (yield* db.getSession(id))!
      assert.deepInclude(row, { harnessId: "cursor", executionState: "open" })
      const executions = yield* sql<{
        id: number
        status: string
        inbox: number | null
        task: number
      }>`SELECT m.id, m.status AS status, m.inbox_id AS inbox,
        (SELECT id FROM inbox WHERE session_id = m.session_id AND kind IN ('task', 'send') ORDER BY id LIMIT 1) AS task
        FROM ${sql.literal(EXECUTIONS)} m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      assert.deepStrictEqual(
        executions.map((execution) => [
          execution.id === executionId,
          execution.status,
          execution.inbox === execution.task,
        ]),
        [
          [true, "failed", true],
          [false, "not_started", false],
          [false, "working", false],
        ],
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      assert.deepStrictEqual(yield* sqlNotices(id), [])
      yield* writeEnd(id, "cursor", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", executionState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor", "claude"],
      )
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  test(
    "a limit resends the open execution's input, not the original task: a typed execution's text, the newest delivered follow-up, a whole merged batch",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const resends = <E, R>(deliver: (id: string) => Effect.Effect<unknown, E, R>, input: string) =>
        Effect.gen(function* () {
          const { id, db } = yield* spawnWorking(repo)
          yield* writeEnd(id, "pi", { text: "status: completed" })
          yield* herdr.endExecution(id)
          yield* sessions.check(id)
          yield* deliver(id)
          yield* writeEnd(id, "pi", { error: "rate_limit" })
          yield* herdr.endExecution(id)
          yield* sessions.check(id)
          assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude", input)
          assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, input)
          assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
        })
      yield* resends((id) => sessions.userPrompt(id, "typed follow-up"), "typed follow-up")
      yield* resends(
        (id) =>
          Effect.gen(function* () {
            yield* sessions.send(id, "add tests")
            yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)?.text === "add tests")
          }),
        "add tests",
      )
      yield* resends(
        (id) =>
          Effect.gen(function* () {
            const held = yield* herdr.hold("state", id)
            yield* sessions.send(id, "add tests")
            yield* held.reached
            yield* sessions.send(id, "and docs")
            yield* held.release()
            yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)?.text === "add tests\n\nand docs")
          }),
        "add tests\n\nand docs",
      )
    }),
    { plugins: [chooseNext] },
  )

  test(
    "an explicit limited harness reaches the hooks with its subscription rows, and a plugin may replace it",
    Effect.gen(function* () {
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const started = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      assert.strictEqual(started.harness, "claude")
      assert.deepStrictEqual(started.decidedBy, { harness: "rewrite" })
    }),
    {
      plugins: [
        Plugin.define({
          id: "rewrite",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.succeed(
                e.harness === "pi" && e.subscriptions.some((row) => row.harness === "pi" && isLimited(row))
                  ? { harness: "claude" }
                  : undefined,
              ),
            ),
        }),
      ],
    },
  )

  test(
    "a launch start that dies on its own usage limit moves and resends the launch prompt",
    Effect.gen(function* () {
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
      yield* held.release("rate_limit")
      yield* Fiber.join(spawning)
      const id = (yield* db.listSessions())[0]!.id
      yield* until(db.getSession(id), (w) => !!w && w.harnessId === "claude" && w.executionState === "open")
      yield* until(herdr.callsTo("send"), (calls) => calls.length > 0)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
      const sql = yield* SqlClient.SqlClient
      const [execution] = yield* sql<{
        input: string
      }>`SELECT input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(execution!.input, "do it")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude"],
      )
    }),
    { plugins: [chooseNext] },
  )

  test(
    "a move starts on the harness, provider and model agent.fail chose",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository, "claude")
      yield* writeEnd(id, "claude", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* (yield* Sessions).check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "openai", model: "fake-strong" })
      const args = (yield* herdr.callsTo("open")).at(-1)!.argv
      assert.strictEqual(args[args.indexOf("--provider") + 1], "openai")
      assert.strictEqual(args[args.indexOf("--model") + 1], "fake-strong")
    }),
    {
      noRun: true,
      plugins: [
        Plugin.define({
          id: "cheap-second",
          effect: (ctx) =>
            ctx.agent.hook("fail", () => Effect.succeed({ harness: "pi", provider: "openai", model: "fake-strong" })),
        }),
      ],
    },
  )

  test(
    "one limited pi login only rules out that login: a pi session still starts, a move stays on pi or goes to pi with the free one, and the limit is remembered on the session",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      yield* subs.report({
        harness: "pi",
        provider: "zai",
        limits: [{ window: "5h", percent: 5, status: "available", resetTime: null }],
      })
      yield* TestClock.adjust("10 seconds")
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "zai", executionState: "open" })
      const stored = (yield* db.getSession(id))!.metadata.attempts
      assert.strictEqual(stored?.length, 1)
      assert.isAtLeast(stored![0]!.at, 10_000)
      assert.deepStrictEqual(
        { ...stored![0]!, at: 0 },
        { harness: "pi", provider: "openai", outcome: "limited", at: 0 },
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "pi"],
      )
      const args = (yield* herdr.callsTo("open")).at(-1)!.argv
      assert.notInclude(args, "--provider")
      const started = yield* spawnWorking(repo)
      assert.strictEqual((yield* db.getSession(started.id))!.harnessId, "pi")
      const other = yield* spawnWorking(repo, "claude")
      yield* writeEnd(other.id, "claude", { error: "rate_limit" })
      yield* herdr.endExecution(other.id)
      yield* sessions.check(other.id)
      assert.deepInclude(yield* db.getSession(other.id), { harnessId: "pi", provider: "zai", executionState: "open" })
      assert.notInclude((yield* herdr.callsTo("open")).at(-1)!.argv, "--provider")
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  test(
    "a start chain that pins the move back to the login that hit the limit ends instead of looping",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "zai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "zai", executionState: "failed" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "notice"))!.message, "no harness left")
    }),
    {
      plugins: [
        chooseNext,
        Plugin.define({
          id: "zai-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.succeed(
                e.attempts.length > 0 ? { harness: "pi", provider: "zai", model: "fake-strong" } : undefined,
              ),
            ),
        }),
      ],
    },
  )

  test(
    "a login limited in this execution is not tried again in it, even when its row reads free; a later execution may use it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const sql = yield* SqlClient.SqlClient
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      const free = [{ window: "5h", percent: 5, status: "available" as const, resetTime: null }]
      const limitedEnds = sql<{ harness: string; provider: string | null }>`SELECT harness, provider FROM process
        WHERE session_id = ${id} AND end_reason = 'limited' ORDER BY ended_at, id`.pipe(Effect.orDie)
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      yield* TestClock.adjust("10 seconds")
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      yield* TestClock.adjust("10 seconds")
      yield* subs.report({ harness: "pi", provider: "openai", limits: free })
      yield* writeEnd(id, "claude", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", executionState: "failed" })
      assert.include((yield* db.latestInbox(id, "notice"))!.message, "no harness left")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude"],
      )
      assert.deepStrictEqual(yield* limitedEnds, [{ harness: "pi", provider: "openai" }])
      yield* TestClock.adjust("10 seconds")
      yield* sessions.send(id, "next")
      yield* until(db.getSession(id), (w) => w?.executionState === "open")
      yield* TestClock.adjust("10 seconds")
      yield* writeEnd(id, "claude", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "openai", executionState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "pi"],
      )
      assert.deepStrictEqual(yield* limitedEnds, [
        { harness: "pi", provider: "openai" },
        { harness: "claude", provider: null },
      ])
    }),
    {
      noRun: true,
      plugins: [
        Plugin.define({
          id: "two-logins",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.succeed(e.harness === "pi" ? { harness: "claude" } : { harness: "pi", provider: "openai" }),
            ),
        }),
      ],
    },
  )

  test(
    "a start chain that keeps sending the move to a harness it ruled out ends instead of looping",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* (yield* Sessions).check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "pi")
      assert.strictEqual((yield* db.getSession(id))!.executionState, "failed")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "notice"))!.message, "no harness left")
    }),
    {
      unusable: ["cursor"],
      plugins: [
        chooseNext,
        Plugin.define({
          id: "cursor-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.succeed(e.attempts.length > 0 ? { harness: "cursor" } : undefined),
            ),
        }),
      ],
    },
  )

  test(
    "a start.before refusal skips the candidate harness of a move",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* (yield* Sessions).check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "cursor"],
      )
    }),
    {
      noRun: true,
      plugins: [
        chooseNext,
        Plugin.define({
          id: "no-claude",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              e.harness === "claude"
                ? Effect.fail(new PluginRefused({ reason: "claude is not allowed here" }))
                : Effect.void,
            ),
        }),
      ],
    },
  )

  const moveSeen: FailSeen = []
  test(
    "agent.fail gets the real parent and the attempts, and the subscriptions",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "pi", { underMain: true })
      const row = (yield* db.getSession(id))!
      const main = (yield* db.coordinatorOf(row.projectId))!
      yield* subs.report({
        harness: "pi",
        provider: "openai",
        limits: [{ window: "5h", percent: 12, status: "available", resetTime: null }],
      })
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(moveSeen.length, 1)
      const seen = moveSeen[0]!
      assert.strictEqual(seen.parent, main.id)
      assert.deepStrictEqual(seen.attempts, [["pi", "limited"]])
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
    }),
    {
      plugins: [
        chooseNext,
        Plugin.define({
          id: "see-move",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                moveSeen.push({ parent: e.parentSessionId, attempts: e.attempts.map((a) => [a.harness, a.outcome]) })
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a failed place on the next hop closes the pane this attempt owns and fails the execution once",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const original = (yield* herdr.agent(id))!.terminal
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* herdr.endExecution(id)
      const placing = yield* herdr.hold("open")
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* placing.reached
      const prompting = yield* herdr.hold("send", id)
      yield* placing.release()
      yield* prompting.reached
      const placingAgain = yield* herdr.hold("open")
      yield* prompting.release("failed")
      yield* placingAgain.reached
      yield* placingAgain.release("not_found")
      yield* Fiber.join(checking)
      const closes = (yield* herdr.callsTo("close")).map((call) => call.terminal)
      assert.strictEqual(closes[0], original)
      assert.lengthOf(closes, 2)
      assert.isFalse(HashMap.has(yield* herdr.panes, closes[1]!))
      assert.isFalse((yield* herdr.agent(id))!.agent.alive)
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.harnessId, "claude")
      assert.strictEqual(row.executionState, "failed")
      assert.isNotNull(row.exitedAt)
      assert.include((yield* db.latestInbox(id, "notice"))!.message, "placing the next pane failed")
      const results = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${id} AND kind = 'notice'`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.lengthOf(yield* sqlNotices(id), 1)
    }),
    { noRun: true, plugins: [chooseNext] },
  )
})
