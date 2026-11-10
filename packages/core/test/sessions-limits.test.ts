import { assert, describe } from "@effect/vitest"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { AgentRefused as PluginRefused, Plugin } from "@vibest/plugin"
import { Effect, Fiber, FileSystem, HashMap } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { TURNS, writeResult, resultText, systemPromptFile } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import {
  harnessOf,
  spawnWorking,
  sessionWorktree,
  test,
  sqlNotices,
  limited,
  chooseNext,
  type FailSeen,
} from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "a usage-limit failure of a running session reports the limit and starts nothing else",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const resetTime = Date.parse("2099-01-01T00:00:00.000Z")
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* (yield* Subscriptions).report({
        harness: "pi",
        limits: [{ window: "5h", percent: 100, status: "limited", resetTime }],
      })
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.harnessId, "pi")
      assert.strictEqual(row.turnState, "failed")
      assert.include(
        (yield* db.latestInbox(id, "result"))!.message,
        `pi: 5h limit exhausted, resets ${new Date(resetTime).toISOString()}`,
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
    }),
  )

  test(
    "a usage-limit move writes the system prompt again: memory written since the first start is in it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* spawnWorking(repo)
      assert.notInclude(yield* fs.readFileString(yield* systemPromptFile(id)), "learned before the move")
      const memory = `${layout.project(String((yield* db.getSession(id))!.projectId))}/memories`
      yield* fs.makeDirectory(memory, { recursive: true })
      yield* fs.writeFileString(`${memory}/moved.md`, "learned before the move")
      yield* fs.writeFileString(yield* systemPromptFile(id), "stale text")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      const [run] = yield* herdr.callsTo("run")
      assert.include(run!.argv, yield* systemPromptFile(id))
      const prompt = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(prompt, "learned before the move")
      assert.notInclude(prompt, "stale text")
    }),
    { plugins: [chooseNext] },
  )

  test(
    "a turn-end rate limit moves the subagent to another harness and the task's round carries the result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const project = (yield* db.getSession(id))!.projectId
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const moved = (yield* db.getSession(id))!
      assert.strictEqual(moved.harnessId, "claude")
      assert.strictEqual(moved.turnState, "open")
      assert.deepStrictEqual(yield* db.coordinatorPending(project), [])
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
      assert.strictEqual((yield* herdr.callsTo("open")).at(-1)!.cwd, yield* sessionWorktree(id))
      assert.lengthOf(yield* herdr.callsTo("close"), 1)
      assert.isTrue((yield* herdr.callsTo("open")).at(-1)!.argv.includes("--plugin-dir"))
      const rounds = () =>
        sql<{ status: string; inbox: number | null; task: number }>`SELECT m.status AS status, m.inbox_id AS inbox,
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND kind IN ('task', 'send') ORDER BY id LIMIT 1) AS task
        FROM ${sql.literal(TURNS)} m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      const open = yield* rounds()
      assert.strictEqual(open.length, 1)
      assert.strictEqual(open[0]!.status, "working")
      assert.isNotNull(open[0]!.inbox)
      assert.strictEqual(open[0]!.inbox, open[0]!.task)

      yield* writeResult(id, "claude", { last_assistant_message: "status: completed\nsummary: early" }, -60_000)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* writeResult(id, "pi", { error: "rate_limit", text: "status: completed\nsummary: stale" })
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.include(yield* resultText(id), "stale")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.include(yield* resultText(id), "stale")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude"],
      )

      yield* writeResult(id, "claude", { last_assistant_message: "status: completed\nsummary: moved" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* rounds(), [{ status: "completed", inbox: open[0]!.inbox, task: open[0]!.task }])
      const result = (yield* db.coordinatorPending(project)).find((row) => row.kind === "result")
      assert.include(result!.message, "moved")
      assert.notInclude(result!.message, "stale")
      const linked = yield* sql<{
        inbox: number | null
      }>`SELECT m.inbox_id AS inbox FROM inbox i JOIN ${sql.literal(TURNS)} m ON m.end_id = i.result_event_id WHERE i.sender_session_id = ${id}`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(linked[0]!.inbox, open[0]!.inbox)
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  test(
    "abort and model_not_found stay failures and a missing hook stays lost while the subscription is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const aborted = yield* spawnWorking(repo)
      const missing = yield* spawnWorking(repo)
      const lost = yield* spawnWorking(repo)
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const fail = (
        id: string,
        sessions: typeof aborted.sessions,
        db: typeof aborted.db,
        error: string,
        details?: string,
      ) =>
        Effect.gen(function* () {
          yield* writeResult(id, "pi", details === undefined ? { error } : { error, error_details: details })
          yield* herdr.endTurn(id)
          yield* sessions.check(id)
          const row = (yield* db.getSession(id))!
          assert.strictEqual(row.harnessId, "pi")
          assert.strictEqual(row.turnState, "failed")
          const result = yield* db.latestInbox(id, "result")
          assert.include(result!.message, error)
          assert.notInclude(result!.message, "no harness left")
        })
      yield* fail(aborted.id, aborted.sessions, aborted.db, "aborted")
      yield* fail(missing.id, missing.sessions, missing.db, "model_not_found", "usage limit")
      yield* herdr.endTurn(lost.id)
      yield* lost.sessions.check(lost.id)
      assert.strictEqual((yield* lost.db.getSession(lost.id))!.turnState, "open")
      yield* TestClock.adjust("11 seconds")
      yield* lost.sessions.check(lost.id)
      assert.deepInclude(yield* lost.db.getSession(lost.id), { harnessId: "pi", turnState: "lost" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "pi", "pi"],
      )
    }),
  )

  test(
    "a failed pane close does not start a second agent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const pane = (yield* herdr.agent(id))!.terminal
      const held = yield* herdr.hold("close")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* TestClock.adjust("2 seconds")
      yield* herdr.endTurn(id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* held.release("failed")
      yield* Fiber.join(checking)
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.lengthOf(yield* herdr.callsTo("send"), 1)
      const agent = (yield* herdr.agent(id))!
      assert.strictEqual(harnessOf((yield* herdr.callsTo("open")).at(-1)!.argv), "pi")
      assert.strictEqual(agent.terminal, pane)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.harnessId, "pi")
      assert.strictEqual(row.turnState, "failed")
      assert.isNull(row.exitedAt)
      assert.include((yield* db.latestInbox(id, "result"))!.message, "closing its terminal failed")
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  test(
    "a start failure after a limit tries the next harness and is not remembered, so the next limit can use that harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("open", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* held.release("failed to start claude")
      yield* Fiber.join(checking)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "cursor", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      assert.include((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
      yield* writeResult(id, "cursor", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor", "claude"],
      )
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  const failSeen: FailSeen = []
  test(
    "an unusable harness is never offered; the give-up names only real limits",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      assert.deepStrictEqual(failSeen, [{ parent: undefined, attempts: [["pi", "limited"]] }])
      yield* writeResult(id, "cursor", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.turnState, "failed")
      assert.isNull(row.exitedAt)
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "cursor: rate_limit")
      assert.strictEqual(message.includes("claude"), false)
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "cursor"],
      )
    }),
    {
      noRun: true,
      unusable: ["claude"],
      plugins: [
        chooseNext,
        Plugin.define({
          id: "see-again",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                failSeen.push({ parent: e.parentSessionId, attempts: e.attempts.map((a) => [a.harness, a.outcome]) })
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a prompt failure after a limit tries the next harness and the task round carries the result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("send", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      yield* held.release("failed to start claude")
      yield* Fiber.join(checking)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      const rounds = () =>
        sql<{ status: string; inbox: number | null; task: number }>`SELECT m.status AS status, m.inbox_id AS inbox,
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND kind IN ('task', 'send') ORDER BY id LIMIT 1) AS task
        FROM ${sql.literal(TURNS)} m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      const open = yield* rounds()
      assert.deepStrictEqual(
        open.map((row) => [row.status, row.inbox === row.task]),
        [["working", true]],
      )
      yield* writeResult(id, "cursor", { text: "status: completed\nsummary: moved" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepStrictEqual(
        (yield* rounds()).map((row) => [row.status, row.inbox === row.task && row.inbox === open[0]!.inbox]),
        [["completed", true]],
      )
    }),
    { plugins: [chooseNext] },
  )

  test(
    "a plugin that overrides the builtin's move with another harness starts there",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "cursor"],
      )
    }),
    {
      noRun: true,
      plugins: [
        Plugin.define({
          id: "pick",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = { harness: "cursor" }
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a plugin that repeats a tried harness ends with no harness left",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "pi")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
    }),
    {
      plugins: [
        Plugin.define({
          id: "stuck",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = { harness: "pi" }
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a refused move target is named as tried and not started",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.harnessId, "pi")
      assert.strictEqual(row.turnState, "failed")
      assert.include((yield* db.latestInbox(id, "result"))!.message, "claude tried and did not start")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
    }),
    {
      plugins: [
        Plugin.define({
          id: "refuse-claude",
          effect: (ctx) =>
            Effect.gen(function* () {
              yield* ctx.agent.hook("start.before", (event) =>
                event.harness === "claude" ? Effect.fail(new PluginRefused({ reason: "no claude" })) : Effect.void,
              )
              yield* ctx.agent.hook("fail", (event) =>
                Effect.sync(() => {
                  if (!event.attempts.some((attempt) => attempt.harness === "claude"))
                    event.move = { harness: "claude" }
                }),
              )
            }),
        }),
      ],
    },
  )

  test(
    "a plugin that unsets the move keeps the still-running agent listed with one failed result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const pane = (yield* herdr.agent(id))!.terminal
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.turnState, "failed")
      assert.isNull(row.exitedAt)
      assert.include(
        (yield* db.listSessions()).map((s) => s.id),
        id,
      )
      assert.isTrue(HashMap.has(yield* herdr.panes, pane))
      assert.strictEqual(harnessOf((yield* herdr.callsTo("open"))[0]!.argv), "pi")
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.include((yield* db.latestInbox(id, "result"))!.message, "pi: rate_limit")
      const results = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${id} AND kind = 'result'`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    {
      plugins: [
        Plugin.define({
          id: "end-now",
          effect: (ctx) =>
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = undefined
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a limit with every harness limited fails the round naming each",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const subs = yield* Subscriptions
      for (const harness of ["pi", "claude", "cursor"] as const) yield* subs.report({ harness, limits: [limited] })
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      const row = (yield* db.getSession(id))!
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.strictEqual(row.turnState, "failed")
      assert.isNull(row.exitedAt)
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "pi: 5h limit exhausted, no reset time")
      assert.strictEqual(message.includes("claude"), false)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
  )

  test(
    "a move that dies on the last harness closes the new pane and stops that agent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const original = (yield* herdr.agent(id))!.terminal
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("send", id)
      const checking = yield* Effect.forkChild((yield* Sessions).check(id))
      yield* held.reached
      yield* held.release("failed")
      yield* Fiber.join(checking)
      const closes = (yield* herdr.callsTo("close")).map((call) => call.terminal)
      assert.deepStrictEqual(closes[0], original)
      assert.lengthOf(closes, 2)
      assert.isFalse(HashMap.has(yield* herdr.panes, closes[1]!))
      assert.isFalse((yield* herdr.agent(id))!.agent.alive)
      assert.include((yield* db.latestInbox(id, "result"))!.message, "rate_limit")
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    {
      noRun: true,
      plugins: [
        Plugin.define({
          id: "once",
          effect: (ctx) => {
            let first = true
            return ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = first ? { harness: "claude" } : undefined
                first = false
              }),
            )
          },
        }),
      ],
    },
  )

  test(
    "a give-up whose pane will not close fails the turn once and leaves that pane",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const original = (yield* herdr.agent(id))!.terminal
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const closing = yield* herdr.hold("close")
      const checking = yield* Effect.forkChild((yield* Sessions).check(id))
      yield* closing.reached
      const prompting = yield* herdr.hold("send", id)
      yield* closing.release()
      yield* prompting.reached
      const closingAgain = yield* herdr.hold("close")
      yield* prompting.release("failed")
      yield* closingAgain.reached
      yield* closingAgain.release("failed")
      yield* Fiber.join(checking)
      const closes = (yield* herdr.callsTo("close")).map((call) => call.terminal)
      assert.strictEqual(closes[0], original)
      assert.lengthOf(closes, 2)
      const kept = closes[1]!
      assert.isTrue(HashMap.has(yield* herdr.panes, kept))
      assert.isFalse(HashMap.has(yield* herdr.panes, original))
      const agent = (yield* herdr.agent(id))!
      assert.strictEqual(harnessOf((yield* herdr.callsTo("open")).at(-1)!.argv), "claude")
      assert.strictEqual(agent.terminal, kept)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.harnessId, "claude")
      assert.strictEqual(row.turnState, "failed")
      assert.isNull(row.exitedAt)
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "closing its terminal failed")
      assert.notInclude(message, "no harness left")
      const results = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${id} AND kind = 'result'`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    {
      noRun: true,
      plugins: [
        Plugin.define({
          id: "close-fails",
          effect: (ctx) => {
            let first = true
            return ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = first ? { harness: "claude" } : undefined
                first = false
              }),
            )
          },
        }),
      ],
    },
  )
})
