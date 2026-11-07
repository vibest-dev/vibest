import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import type { HarnessId } from "@vibest/core/harness"
import { claude } from "@vibest/core/harnesses/claude"
import { cursor } from "@vibest/core/harnesses/cursor"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { AgentRefused } from "@vibest/core/plugins"
import { peerAdmitPause, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { AgentRefused as PluginRefused, isLimited, Plugin, stillLimited } from "@vibest/plugin"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { ID } from "@vibest/schema/id"
import { prompt, turnEnd } from "@vibest/server/hooks"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  HashMap,
  Path,
  PlatformError,
  Ref,
  type Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import {
  FakeRuntime,
  FakeProcesses,
  makeRepository,
  settled,
  sh,
  testLayer,
  TURNS,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeResult,
  resultText,
  systemPromptFile,
  projectOf,
  processEnds,
} from "./fakes.ts"

const harnessOf = (argv: ReadonlyArray<string>) => (argv[0] === "cursor-agent" ? "cursor" : argv[0])

const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(
    projectOf(repo),
    (projectId) =>
      ({ machine: { id: "local" }, root: repo, projectId, name: "task", prompt: "do it", harness }) as const,
  )

const claudeEnd = (reason: string) =>
  (
    claude.turnEnd!(
      { hook_event_name: "TurnComplete", session_id: "c1", reason, last_assistant_message: "" },
      false,
    ) as {
      readonly result: object
    }
  ).result

const spawnWorking = (repo: string, harness: HarnessId = "pi") =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    })
    const { id } = yield* sessions.spawn(yield* spawnInput(repo, harness))
    yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
    yield* sessions.check(id)
    yield* (yield* FakeRuntime).seedAgent("test/coord")
    yield* settled
    const row = (yield* db.getSession(id))!
    return { id, row, sessions, db }
  })

const idleSession = (repo: string) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const w = yield* spawnWorking(repo)
    yield* writeResult(w.id, "pi", { text: "status: completed" })
    yield* herdr.endTurn(w.id)
    yield* w.sessions.check(w.id)
    yield* settled
    return w
  })

const sessionWorktree = (id: string) =>
  Effect.gen(function* () {
    const located = yield* (yield* Db).sessionDirectory(id)
    if (!located) return yield* Effect.die(`no worktree for ${id}`)
    return located
  })

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
  touchesProcessWideSeam = false,
) =>
  it.effect(
    name,
    () => program.pipe(Effect.provide(testLayer(options))),
    touchesProcessWideSeam ? { concurrent: false } : undefined,
  )

const SPAWN_HEAVY_TEST_TIMEOUT = 90_000

const slowTest = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(testLayer(options))), { timeout: SPAWN_HEAVY_TEST_TIMEOUT })

const pick = (w: { readonly status: string; readonly turnState: string } | undefined) => ({
  status: w?.status,
  turnState: w?.turnState,
})
const roundAndResultCounts = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [rounds] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM ${sql.literal(TURNS)} m WHERE session_id = ${sessionId}`.pipe(Effect.orDie)
    const [results] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${sessionId} AND kind = 'result'`.pipe(Effect.orDie)
    return { rounds: rounds!.n, results: results!.n }
  })
const sqlNotices = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      message: string
    }>`SELECT m.content AS message FROM inbox m WHERE m.kind = 'notice' AND m.sender_session_id = ${sessionId} ORDER BY m.id`.pipe(
      Effect.orDie,
    )
    return rows.map((r) => r.message)
  })

describe.concurrent("Sessions", () => {
  test(
    "spawn: detached worktree with copied files, env on the tab, rules, unchanged prompt",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const { id, row } = yield* spawnWorking(repo)
      assert.match(id, ID)
      assert.strictEqual(row.status, "working")
      assert.strictEqual(row.turnState, "open")

      const wt = yield* sessionWorktree(id)
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      assert.strictEqual(yield* sh(repo, "branch", "--list", "herdr-*"), "")
      assert.isFalse(yield* fs.exists(path.join(wt, "CLAUDE.md")))
      assert.strictEqual(yield* sh(wt, "status", "--porcelain"), "")
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.deepStrictEqual([placed.project, placed.cwd], [repo, wt])
      assert.deepInclude(placed.env, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: id, VIBEST_HOME: layout.home })
      assert.strictEqual(placed.env.VIBEST_PROJECT_DIR, layout.project((yield* (yield* Db).getSession(id))!.projectId))
      const identity = (yield* (yield* Db).sessionIdentity(id))!
      assert.deepInclude(placed.env, { VIBEST_PROJECT_ID: String(identity.projectId), VIBEST_HARNESS: "pi" })
      const runtime = JSON.parse(placed.env.VIBEST_RUNTIME!) as Record<string, unknown>
      assert.deepStrictEqual(Object.keys(runtime).sort(), ["machine", "runtime"])
      assert.strictEqual(runtime.machine, "local")
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      const start = (yield* herdr.callsTo("open"))[0]!
      assert.strictEqual(start.env.VIBEST_SESSION_ID, id)
      assert.deepStrictEqual(start.argv, [
        "pi",
        "--session-id",
        row.harnessSessionId!,
        "--append-system-prompt",
        yield* systemPromptFile(id),
        "-e",
        "/vibest/harnesses/pi/extension.mjs",
      ])
      assert.include(yield* fs.readFileString(yield* systemPromptFile(id)), `You are agent ${id}`)
      assert.strictEqual((yield* herdr.callsTo("send"))[0]!.text, "do it")
    }),
  )

  test(
    "a turn end reported while vibestd drains (update, daemon restart) is still written: its check is a settlement",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const drain = yield* Drain
      assert.isTrue(yield* drain.begin)
      yield* writeResult(id, "pi", { text: "done while draining" })
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")
      assert.strictEqual(w.turnState, "completed")
      assert.include((yield* db.latestInbox(id, "result"))!.message, "done while draining")
      yield* drain.reopen
    }),
  )

  test(
    "hook result + TurnEnd ends the turn and becomes a result row for the owner",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "\nDone it.\nstatus: failed\n\n## Remember\nuse bun" })
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")
      assert.strictEqual(w.turnState, "completed")
      const row = yield* db.latestInbox(id, "result")
      assert.strictEqual(row!.kind, "result")
      assert.include(
        row!.message,
        `<agent-result>\n<agent-id>${id}</agent-id>\n<status>completed</status>\n<summary>Done it.</summary>\n<harness>pi</harness>\n<worktree>`,
      )
      assert.include(row!.message, "<result>\n\nDone it.\nstatus: failed\n\n## Remember\nuse bun\n</result>")
      assert.deepInclude(row!.details, { status: "completed", summary: "Done it." })
    }),
    { hooked: ["pi"] },
  )

  test(
    "herdr's push of a status change runs the check: no poll, no TurnEnd",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")
      assert.deepStrictEqual(pick(w), { status: "idle", turnState: "completed" })
    }),
    { hooked: ["pi"], statusEvents: true },
  )

  test(
    "a result file from before the prompt is ignored",
    Effect.gen(function* () {
      yield* TestClock.adjust("2 minutes")
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "old" }, -60_000)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a typed round ends like any round: one result to the parent; typing during an open round records nothing",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* spawnWorking(repo)
      const main = (yield* sql<{ id: string }>`SELECT entry_session_id AS id FROM project`)[0]!.id
      const results = () =>
        sql<{
          recipient: string
          sender: string | null
          input: string
          output: string | null
          inbox: number | null
        }>`SELECT i.recipient_session_id AS recipient,
            i.sender_session_id AS sender, m.input, m.output, m.inbox_id AS inbox
          FROM inbox i JOIN ${sql.literal(TURNS)} m ON m.end_id = i.result_event_id ORDER BY i.id`.pipe(Effect.orDie)

      yield* sessions.userPrompt(main, "hello")
      yield* sessions.userPrompt(id, "do it")
      yield* sessions.userPrompt(id, "and this")
      const working = yield* sql<{
        input: string
        inbox: number | null
      }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(
        working.map((row) => [row.input, row.inbox !== null]),
        [["do it", true]],
      )
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: done it" })
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")

      const input = "a".repeat(2001)
      yield* sessions.userPrompt(id, input)
      const open = yield* sql<{
        input: string
        inbox: number | null
        status: string
      }>`SELECT input, inbox_id AS inbox, status FROM ${sql.literal(TURNS)} m
        WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(open, [{ input, inbox: null, status: "working" }])
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: typed" })
      const done = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")
      assert.strictEqual(done.turnState, "completed")
      const rows = yield* results()
      assert.deepStrictEqual(
        rows.map((r) => [r.recipient, r.sender, r.input, r.inbox === null]),
        [
          [main, id, "do it", false],
          [main, id, input, true],
        ],
      )
      assert.include(rows[1]!.output, "summary: typed")
      assert.deepStrictEqual(yield* sql`SELECT id FROM inbox WHERE kind = 'notice'`.pipe(Effect.orDie), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "an explicit harness whose plugin is missing is refused with that problem",
    Effect.gen(function* () {
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.deepInclude(refused, { plugin: "harness-choice" })
      assert.include(refused.reason, "pi: vibest's pi plugin is missing")
      assert.strictEqual(refused.reason.includes("claude"), false)
    }),
    { hooked: [] },
  )

  test(
    "spawn with no logged-in harness is refused, naming the model failures",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.include(refused.reason, "pi: pi model discovery failed: Not logged in")
      assert.strictEqual(yield* herdr.callCount, 0)
      assert.deepStrictEqual(yield* db.listSessions(), [])
    }),
    { unusable: ["pi", "claude", "cursor"] },
  )

  test(
    "spawn refuses a model the harness does not list, naming the choices",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const error = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), model: "gpt-9" }))
      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.include(error.message, 'does not list model "gpt-9"; choose one of: fake-model, fake-strong')
      assert.strictEqual(yield* herdr.callCount, 0)
      yield* sessions.spawn({ ...(yield* spawnInput(repo)), model: "fake-strong" })
    }),
  )

  test(
    "an ended turn waits for the hook (grace period), then is lost with a reason and the peek command, never the pane tail",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { turnState: "lost", exitedAt: null })
      const row = yield* db.latestInbox(id, "result")
      assert.include(row!.message, "<status>failed</status>")
      assert.include(row!.message, "the turn ended without a report")
      assert.include(row!.message, `<summary>Agent "task" failed: the turn ended without a report`)
      assert.include(row!.message, `to see its terminal, run: vibest peek ${id}`)
      assert.notInclude(row!.message, "pane tail")
      assert.notInclude(row!.message, "terminal tail")
    }),
  )

  test(
    "--env reaches the session's first terminal and is never stored; a later terminal starts without it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const repo = yield* makeRepository
      const sessions = yield* Sessions
      const db = yield* Db
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), env: { VBT_TOKEN: "s3cret" } })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("open"))[0]!.env.VBT_TOKEN, "s3cret")
      const stored = yield* sql<{
        metadata: string
      }>`SELECT data AS metadata FROM event UNION ALL SELECT name || directory FROM session`.pipe(Effect.orDie)
      assert.isFalse(
        stored.some((r) => r.metadata.includes("s3cret")),
        "no session row holds the value",
      )
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* untilVirtual(sessions.inMemory, (m) => m.tracked === 0 && m.locks === 0)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      for (const open of (yield* herdr.callsTo("open")).slice(1)) assert.isUndefined(open.env.VBT_TOKEN)
    }),
  )

  test(
    "a session's in-memory flags, lock and live status go once it ends; resumed, its next turn ends as any turn does; archived, they go again with no check of its own",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      assert.deepInclude(yield* sessions.inMemory, { tracked: 1, locks: 0 })
      assert.strictEqual(yield* db.liveStatuses, 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* Effect.all([sessions.check(id), sessions.check(id), sessions.check(id)], { concurrency: "unbounded" })
      yield* settled
      assert.deepInclude(yield* db.getSession(id), { turnState: "failed" })
      assert.strictEqual(yield* db.liveStatuses, 0)
      yield* until(sessions.inMemory, (m) => m.tracked === 0 && m.locks === 0)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { turnState: "open", exitedAt: null })
      yield* writeResult(id, "pi", { text: "done again" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { turnState: "completed" })
      assert.include((yield* db.latestInbox(id, "result"))!.message, "done again")
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* sessions.inMemory).tracked, 1)
      assert.deepInclude(yield* db.getSession(id), { status: "idle" })
      yield* sessions.remove(id)
      assert.strictEqual(yield* db.liveStatuses, 0)
      yield* untilVirtual(sessions.inMemory, (m) => m.tracked === 0 && m.locks === 0)
      assert.strictEqual(yield* (yield* Inbox).locks, 0)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a delivery waiting on the exit does not resume once that exit has failed the queued send",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const opens = () => Effect.map(herdr.callsTo("open"), (calls) => calls.length)
      const before = yield* opens()
      const stateHeld = yield* herdr.hold("state", id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* stateHeld.reached
      const processHeld = yield* herdr.hold("process", id)
      yield* stateHeld.release()
      yield* processHeld.reached
      yield* sessions.send(id, "queued")
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      assert.lengthOf(yield* db.pendingInbox(id), 1)
      yield* processHeld.release()
      yield* Fiber.join(checking)
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      yield* settled
      assert.deepInclude(yield* db.getSession(id), { turnState: "failed" })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.lengthOf(yield* db.pendingInbox(id), 0)
      assert.lengthOf(yield* db.inboxWithStatus(id, "failed"), 1)
      assert.strictEqual(yield* opens(), before)
      assert.isTrue((yield* sqlNotices(id)).some((text) => text.includes("exited before it was delivered")))
    }),
  )

  test(
    "two concurrent removes: one removes, the other is refused as already being removed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      const [a, b] = yield* Effect.all(
        [Effect.exit(sessions.remove(id)), Effect.exit(sessions.remove(id)), TestClock.adjust("5 seconds")],
        { concurrency: "unbounded" },
      )
      const refused = [a, b].filter(Exit.isFailure)
      assert.lengthOf(refused, 1)
      assert.include(Cause.pretty(refused[0]!.cause), `${id} is already being removed`)
      assert.isTrue((yield* db.getSession(id))!.metadata.archived)
    }),
  )

  test(
    "blocked: one notice, no answer on the session's behalf",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const promptSends = (yield* herdr.callsTo("send")).length
      yield* herdr.updateAgent(id, (a) => ({ ...a, status: "blocked" }))
      yield* sessions.check(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.status, "blocked")
      const row = yield* db.latestInbox(id, "notice")
      assert.strictEqual(row!.kind, "notice")
      const since = new Date(yield* Clock.currentTimeMillis)
      const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":")
      assert.include(
        row!.message,
        `${id.slice(0, 8)} (pi) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${id.slice(0, 8)} to see the request.`,
      )
      assert.notInclude(row!.message, "Switch to its terminal")
      assert.lengthOf(yield* sqlNotices(id), 1)
      assert.strictEqual((yield* herdr.callsTo("send")).length, promptSends)
    }),
  )

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
      yield* turnEnd(
        db,
        cursor,
        { id, agent: "general" },
        JSON.stringify({ hook_event_name: "afterAgentResponse", text: "done" }),
      )
      const thought = JSON.stringify({ hook_event_name: "afterAgentThought" })
      yield* prompt(sessions, cursor, { id, agent: "general" }, thought)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "completed")
      yield* prompt(sessions, cursor, { id, agent: "general" }, thought)
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

  const limited = { window: "5h", percent: 100, status: "limited" as const, resetTime: null }

  const chooseNext = Plugin.define({
    id: "choose-next",
    effect: (ctx) =>
      ctx.agent.hook("fail", (event) =>
        Effect.sync(() => {
          if (event.reason !== "limited" || event.move !== undefined) return
          const pair = (harness: string, provider: string) => `${harness}\0${provider}`
          const excludedPairs = new Set<string>()
          const excludedHarnesses = new Set(event.attempts.filter((a) => a.outcome !== "limited").map((a) => a.harness))
          for (const attempt of event.attempts) {
            if (attempt.outcome !== "limited") continue
            if (attempt.provider === undefined) excludedHarnesses.add(attempt.harness)
            else if (stillLimited(attempt, event.subscriptions))
              excludedPairs.add(pair(attempt.harness, attempt.provider))
          }
          if (event.provider === undefined) excludedHarnesses.add(event.harness)
          else excludedPairs.add(pair(event.harness, event.provider))
          const fullest = (row: (typeof event.subscriptions)[number]) =>
            row.limits.reduce((max, limit) => Math.max(max, limit.percent), -1)
          const known: Array<{ harness: string; provider: string | undefined; score: number }> = []
          const unknown: Array<string> = []
          for (const option of event.harnesses) {
            if (!option.available || excludedHarnesses.has(option.harness)) continue
            const rows = event.subscriptions.filter(
              (row) =>
                row.harness === option.harness &&
                !isLimited(row) &&
                !excludedPairs.has(pair(option.harness, row.provider)),
            )
            if (rows.length === 0) {
              if (
                event.subscriptions.every((row) => row.harness !== option.harness) &&
                !excludedPairs.has(pair(option.harness, ""))
              )
                unknown.push(option.harness)
              continue
            }
            const row = rows.reduce((a, b) => (fullest(a) <= fullest(b) ? a : b))
            known.push({
              harness: option.harness,
              provider: row.provider === "" ? undefined : row.provider,
              score: fullest(row),
            })
          }
          const picked = known.length > 0 ? known.reduce((a, b) => (a.score <= b.score ? a : b)) : undefined
          const fallback = unknown[0]
          const chosen = picked ?? (fallback === undefined ? undefined : { harness: fallback, provider: undefined })
          if (chosen !== undefined) event.move = chosen
        }),
      ),
  })

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
    "an explicit harness limited before start is refused with that limit and starts nothing",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.deepInclude(refused, { plugin: "harness-choice", reason: "pi: 5h limit exhausted, no reset time" })
      assert.strictEqual(yield* herdr.callCount, 0)
      assert.deepStrictEqual(yield* db.listSessions(), [])
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

  type FailSeen = Array<{ parent: string | undefined; attempts: ReadonlyArray<[string, string]> }>
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

  test(
    "an explicit harness is refused when every login is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const subs = yield* Subscriptions
      yield* subs.report({ harness: "pi", provider: "anthropic", limits: [limited] })
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.strictEqual(
        refused.reason,
        "pi/anthropic: 5h limit exhausted, no reset time; pi/openai: 5h limit exhausted, no reset time",
      )
      assert.strictEqual(yield* herdr.callCount, 0)
      assert.deepStrictEqual(yield* db.listSessions(), [])
    }),
  )

  test(
    "a set provider matches only that login",
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
      const blocked = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), provider: "anthropic" })).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.strictEqual(blocked.reason, "pi/anthropic: 5h limit exhausted, no reset time")
      const fine = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai", name: "other" })
      yield* until(db.getSession(fine.id), (row) => !!row && row.startedAt !== null)
      yield* sessions.check(fine.id)
      assert.deepInclude(yield* db.getSession(fine.id), { harnessId: "pi", provider: "openai", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
    }),
  )

  test(
    "an unconfirmed prompt after a limit tries the next harness, leaves the task round working and is not remembered, so the next limit can use that harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const roundId = (yield* sql<{ id: number }>`SELECT id FROM ${sql.literal(TURNS)} m WHERE session_id = ${id}`.pipe(
        Effect.orDie,
      ))[0]!.id
      yield* Ref.set(herdr.skipPromptUpdates, 2)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* untilVirtual(
        Effect.sync(() => checking.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      const row = (yield* db.getSession(id))!
      assert.deepInclude(row, { harnessId: "cursor", turnState: "open" })
      const rounds = yield* sql<{
        id: number
        status: string
        inbox: number | null
        task: number
      }>`SELECT m.id, m.status AS status, m.inbox_id AS inbox,
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND kind IN ('task', 'send') ORDER BY id LIMIT 1) AS task
        FROM ${sql.literal(TURNS)} m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      assert.deepStrictEqual(
        rounds.map((round) => [round.id, round.status, round.inbox === round.task]),
        [[roundId, "working", true]],
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      assert.deepStrictEqual(yield* sqlNotices(id), [])
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

  test(
    "a limit resends the open round's input, not the original task: a typed turn's text, the newest delivered follow-up, a whole merged batch",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const resends = <E, R>(deliver: (id: string) => Effect.Effect<unknown, E, R>, input: string) =>
        Effect.gen(function* () {
          const { id, db } = yield* spawnWorking(repo)
          yield* writeResult(id, "pi", { text: "status: completed" })
          yield* herdr.endTurn(id)
          yield* sessions.check(id)
          yield* deliver(id)
          yield* writeResult(id, "pi", { error: "rate_limit" })
          yield* herdr.endTurn(id)
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
    "an explicit limited harness is refused before a later plugin can replace it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.deepInclude(refused, { plugin: "harness-choice", reason: "pi: 5h limit exhausted, no reset time" })
      assert.strictEqual(yield* herdr.callCount, 0)
      assert.deepStrictEqual(yield* db.listSessions(), [])
    }),
    {
      plugins: [
        Plugin.define({
          id: "rewrite",
          effect: (ctx) =>
            ctx.agent.hook("start.before", () => Effect.sync(() => assert.fail("must not run after a refusal"))),
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
      yield* until(db.getSession(id), (w) => !!w && w.harnessId === "claude" && w.turnState === "open")
      yield* until(herdr.callsTo("send"), (calls) => calls.length > 0)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
      const sql = yield* SqlClient.SqlClient
      const [round] = yield* sql<{
        input: string
      }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`.pipe(Effect.orDie)
      assert.strictEqual(round!.input, "do it")
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
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
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
            ctx.agent.hook("fail", (e) =>
              Effect.sync(() => {
                e.move = { harness: "pi", provider: "openai", model: "fake-strong" }
              }),
            ),
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
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "zai", turnState: "open" })
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
      yield* writeResult(other.id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(other.id)
      yield* sessions.check(other.id)
      assert.deepInclude(yield* db.getSession(other.id), { harnessId: "pi", provider: "zai", turnState: "open" })
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
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "zai", turnState: "failed" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
    }),
    {
      plugins: [
        chooseNext,
        Plugin.define({
          id: "zai-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                if (e.attempts.length > 0) {
                  e.harness = "pi"
                  e.provider = "zai"
                  e.model = "fake-strong"
                }
              }),
            ),
        }),
      ],
    },
  )

  test(
    "a login limited in this round is not tried again in it, even when its row reads free; a later round may use it",
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
      const limitedEnds = sql<{ harness: string; provider: string | null }>`SELECT
          json_extract(ps.data, '$.harness') AS harness, json_extract(ps.data, '$.provider') AS provider
        FROM event pe JOIN event ps ON ps.id = pe.process_id
        WHERE pe.session_id = ${id} AND pe.type = 'process.end' AND json_extract(pe.data, '$.reason') = 'limited'
        ORDER BY pe.id`.pipe(Effect.orDie)
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      yield* TestClock.adjust("10 seconds")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      yield* TestClock.adjust("10 seconds")
      yield* subs.report({ harness: "pi", provider: "openai", limits: free })
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", turnState: "failed" })
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude"],
      )
      assert.deepStrictEqual(yield* limitedEnds, [{ harness: "pi", provider: "openai" }])
      yield* TestClock.adjust("10 seconds")
      yield* sessions.send(id, "next")
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* TestClock.adjust("10 seconds")
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "openai", turnState: "open" })
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
              Effect.sync(() => {
                e.move = e.harness === "pi" ? { harness: "claude" } : { harness: "pi", provider: "openai" }
              }),
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
    }),
    {
      unusable: ["cursor"],
      plugins: [
        chooseNext,
        Plugin.define({
          id: "cursor-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                if (e.attempts.length > 0) e.harness = "cursor"
              }),
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
      const sql = yield* SqlClient.SqlClient
      const subs = yield* Subscriptions
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const row = (yield* db.getSession(id))!
      const main = (yield* db.coordinatorOf(row.projectId))!
      yield* sql`UPDATE session SET parent_session_id = ${main.id} WHERE id = ${id}`
      yield* subs.report({
        harness: "pi",
        provider: "openai",
        limits: [{ window: "5h", percent: 12, status: "available", resetTime: null }],
      })
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
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
    "a failed place on the next hop closes the pane this attempt owns and fails the turn once",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const original = (yield* herdr.agent(id))!.terminal
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
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
      assert.strictEqual(row.turnState, "failed")
      assert.isNotNull(row.exitedAt)
      assert.include((yield* db.latestInbox(id, "result"))!.message, "placing the next pane failed")
      const results = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE sender_session_id = ${id} AND kind = 'result'`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    { noRun: true, plugins: [chooseNext] },
  )

  test(
    "resuming a session writes today's system prompt and leaves the repository's own files alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      const { id, sessions } = yield* spawnWorking(repo)
      assert.notInclude(yield* fs.readFileString(yield* systemPromptFile(id)), "learned between starts")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const cursorMcp = `${yield* sessionWorktree(id)}/.cursor/mcp.json`
      yield* fs.makeDirectory(`${yield* sessionWorktree(id)}/.cursor`, { recursive: true })
      yield* fs.writeFileString(cursorMcp, JSON.stringify({ mcpServers: { repo: { command: "repo-server" } } }))
      yield* fs.writeFileString(yield* systemPromptFile(id), "use the send_message tool")
      const memory = `${layout.project(String((yield* (yield* Db).getSession(id))!.projectId))}/memories`
      yield* fs.makeDirectory(memory, { recursive: true })
      yield* fs.writeFileString(`${memory}/later.md`, "learned between starts")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))

      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
      assert.isTrue(yield* fs.exists(cursorMcp))
      const prompt = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(prompt, "report -- '<message>'")
      assert.notInclude(prompt, "send_message")
      assert.include(prompt, "learned between starts")
    }),
    { hooked: ["pi"] },
  )

  test(
    "prompt that never registers: Enter, one re-paste, then task_not_started",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "not_started")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "not_started")
      const sends = (yield* herdr.callsTo("send")).slice(1)
      assert.lengthOf(sends, 2)
      assert.deepStrictEqual(sends[0]!.keys, ["enter"])
      const row = yield* db.latestInbox(id, "notice")
      assert.include(row!.message, "task_not_started")
      assert.include(row!.message, `to see its terminal, run: vibest peek ${id}`)
      assert.notInclude(row!.message, "pane tail")
    }),
    { promptsIgnored: true },
  )

  test(
    "a later send whose Enter is swallowed gets Enter again: the previous round's start is no pickup",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.userPrompt(id, "do it")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* TestClock.adjust("1 second")
      yield* herdr.updateAgent(id, (a) => ({ ...a, registerPrompt: false }))
      yield* sessions.send(id, "next")
      const sends = yield* untilVirtual(herdr.callsTo("send"), (calls) => {
        const at = calls.findIndex((c) => c.text === "next")
        return at >= 0 && calls.length > at + 1
      })
      assert.deepStrictEqual(sends[sends.findIndex((c) => c.text === "next") + 1]!.keys, ["enter"])
    }),
    { hooked: ["pi"] },
  )

  test(
    "a queued message the session never starts on: task_not_started fails that batch and tells the owner, with the text",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository))
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "not_started")
      yield* sessions.send(id, "next")
      const notices = yield* untilVirtual(sqlNotices(id), (m) => m.length === 2)
      assert.match(
        notices[1]!,
        new RegExp(`^A message to ${id} was not delivered: task_not_started: .*\\n\\nnext$`, "s"),
      )
      assert.deepStrictEqual(
        (yield* (yield* SqlClient.SqlClient)<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE recipient_session_id = ${id} AND kind IN ('task', 'send') AND id > (SELECT min(id) FROM inbox WHERE recipient_session_id = ${id} AND kind IN ('task', 'send'))`.pipe(
          Effect.orDie,
        )).map((r) => r.status),
        ["failed"],
      )
      assert.lengthOf((yield* herdr.callsTo("send")).slice(1), 5)
    }),
    { promptsIgnored: true },
  )

  test(
    "a queued message stays pending while the session is not ready; once herdr has it, it is sending",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const notReady = yield* herdr.hold("state", id)
      yield* sessions.send(id, "next")
      yield* notReady.reached
      const status = Effect.map(db.inboxWithStatus(id, "pending"), (rows) => rows.map((r) => r.message))
      assert.deepStrictEqual(yield* status, ["next"])
      const held = yield* herdr.hold("send", id)
      yield* notReady.release()
      yield* TestClock.adjust("1 second")
      yield* held.reached
      assert.deepStrictEqual(
        (yield* db.inboxWithStatus(id, "sending")).map((r) => r.message),
        ["next"],
      )
      yield* held.release()
      yield* until(db.inboxWithStatus(id, "delivered"), (rows) => rows.length === 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "launch failure rolls back the worktree and notifies the owner",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const db = yield* Db
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
      assert.isFalse(yield* fs.exists(yield* systemPromptFile(id)))
      yield* (yield* Sessions).check(id)
      const failed = (yield* db.getSession(id))!
      assert.strictEqual(failed.status, "unknown")
      assert.isNotNull(failed.exitedAt)
      assert.deepStrictEqual(yield* (yield* FakeRuntime).callsTo("close"), [])
      const row = yield* db.latestInbox(id, "notice")
      assert.strictEqual(row!.kind, "notice")
      assert.include(row!.message, "failed to start pi")
    }),
    { startError: "spawn_failed" },
  )

  test(
    "a resume whose start fails closes the pane it placed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const placed = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open", id)
      yield* sessions.send(id, "again")
      yield* held.reached
      yield* held.release("failed")
      yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 1)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      const notice = yield* until(sqlNotices(id), (rows) =>
        rows.some((message) => message.includes("A message to") && message.includes("again")),
      )
      assert.include(notice.at(-1)!, "open: failed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a copy failure fails the launch before the harness starts, names the copy, and still rolls the worktree back",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const repo = yield* makeRepository
      yield* fs.writeFileString(path.join(repo, "cfg"), "file\n")
      yield* sh(repo, "add", "cfg")
      yield* sh(repo, "commit", "-q", "-m", "cfg")
      yield* fs.remove(path.join(repo, "cfg"))
      yield* fs.makeDirectory(path.join(repo, "cfg"))
      yield* fs.writeFileString(path.join(repo, "cfg", "x"), "x\n")
      yield* fs.writeFileString(path.join(repo, "a.json"), "{}\n")
      yield* fs.writeFileString(path.join(repo, ".git", "info", "exclude"), "a.json\ncfg/\n", { flag: "a" })
      yield* fs.writeFileString(path.join(repo, ".worktreeinclude"), "a.json\ncfg/x\n")
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.lengthOf(yield* (yield* FakeRuntime).callsTo("open"), 0)
      const row = yield* db.latestInbox(id, "notice")
      assert.include(
        row!.message,
        `failed to start pi: copy ${path.join(repo, "cfg", "x")} -> ${path.join(yield* sessionWorktree(id), "cfg", "x")}`,
      )
      assert.include(row!.message, "(ENOTDIR)")
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
    }),
  )

  test(
    "a copy that fails after an earlier one succeeded still fails the launch, and git rolls back the partly filled worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const repo = yield* makeRepository
      for (const f of ["a.json", "b.json"]) yield* fs.writeFileString(path.join(repo, f), `${f}\n`)
      yield* fs.writeFileString(path.join(repo, ".git", "info", "exclude"), "a.json\nb.json\n", { flag: "a" })
      yield* fs.writeFileString(path.join(repo, ".worktreeinclude"), "a.json\nb.json\n")
      const copied: Array<string> = []
      const faulty = FileSystem.FileSystem.of({
        ...fs,
        copyFile: (from: string, to: string) =>
          path.basename(to) === "b.json"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "copyFile",
                  pathOrDescriptor: from,
                  cause: Object.assign(new Error("EIO"), { code: "EIO" }),
                }),
              )
            : fs.copyFile(from, to).pipe(Effect.tap(() => Effect.sync(() => copied.push(to)))),
      })
      const sessions = yield* Sessions.make({ maxSessions: undefined }).pipe(
        Effect.provideService(FileSystem.FileSystem, faulty),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      const worktree = yield* sessionWorktree(id)
      assert.deepStrictEqual(copied, [path.join(worktree, "a.json")])
      assert.lengthOf(yield* (yield* FakeRuntime).callsTo("open"), 0)
      const row = yield* db.latestInbox(id, "notice")
      assert.include(
        row!.message,
        `failed to start pi: copy ${path.join(repo, "b.json")} -> ${path.join(worktree, "b.json")}`,
      )
      assert.include(row!.message, "(EIO)")
      assert.isFalse(yield* fs.exists(worktree))
      assert.notInclude(yield* sh(repo, "worktree", "list", "--porcelain"), worktree)
      for (const f of ["a.json", "b.json"]) assert.strictEqual(yield* fs.readFileString(path.join(repo, f)), `${f}\n`)
    }),
  )

  test(
    "VIBEST_MAX_SESSIONS counts every non-stopped session",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* spawnWorking(repo)
      const error = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(repo)))
      assert.strictEqual(error._tag, "LimitReached")
    }),
    { maxSessions: 1 },
  )

  test(
    "claude and cursor refuse any provider, anthropic too, before anything is created",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      for (const harness of ["claude", "cursor"] as const)
        for (const provider of ["openai", "anthropic"]) {
          const error = yield* Effect.flip(
            (yield* Sessions).spawn({ ...(yield* spawnInput(yield* makeRepository, harness)), provider }),
          )
          assert.strictEqual(error._tag, "HarnessUnavailable")
          assert.isTrue(error.message.startsWith(`${harness} has no provider option`), error.message)
        }
      assert.strictEqual(yield* herdr.callCount, 0)
    }),
  )

  test(
    "remove keeps what git would lose (changes, untracked files, commits on no branch, a lock) and tries again when asked",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const kept = (out: { readonly worktree: string; readonly reasons: ReadonlyArray<string> }, why: string) => {
        assert.strictEqual(out.worktree, "kept")
        assert.match(out.reasons.join("\n"), new RegExp(why))
      }
      const a = yield* idleSession(repo)
      const wa = yield* sessionWorktree(a.id)
      yield* fs.writeFileString(`${wa}/README.md`, "changed\n")
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      assert.isNotNull((yield* a.db.getSession(a.id))!.exitedAt)
      assert.isTrue(yield* fs.exists(yield* systemPromptFile(a.id)))
      yield* sh(wa, "checkout", "--", "README.md")
      yield* fs.writeFileString(`${wa}/new.txt`, "x")
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      yield* sh(wa, "switch", "-q", "-c", "keep/a")
      yield* sh(wa, "add", ".")
      yield* sh(wa, "commit", "-q", "-m", "work")
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", branch: "keep/a" })

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      yield* fs.writeFileString(`${wb}/b.txt`, "b")
      yield* sh(wb, "add", ".")
      yield* sh(wb, "commit", "-q", "-m", "b")
      kept((yield* b.sessions.remove(b.id))!, "commits not on any branch")
      yield* sh(wb, "update-ref", "refs/remotes/origin/b", "HEAD")
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", branch: null })

      const c = yield* idleSession(repo)
      yield* sh(repo, "worktree", "lock", yield* sessionWorktree(c.id))
      kept((yield* c.sessions.remove(c.id))!, "git refused")
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(c.id)))

      const d = yield* idleSession(repo)
      assert.deepInclude((yield* d.sessions.remove(d.id, { keepWorktree: true }))!, {
        worktree: "kept",
        reasons: ["worktree kept as asked (--keep-worktree)"],
      })
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(d.id)))
    }),
  )

  test(
    "remove: ignored files alone do not keep the worktree, with or without .worktreeinclude; a file git does not ignore does",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      yield* fs.writeFileString(`${repo}/.git/info/exclude`, "local.env\nCLAUDE.md\n", { flag: "a" })
      const a = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(a.id)}/local.env`, "K=1\n")
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", reasons: [] })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(a.id)))

      yield* fs.writeFileString(`${repo}/.worktreeinclude`, "CLAUDE.md\n")
      const b = yield* idleSession(repo)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`), "local rules\n")
      yield* fs.writeFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`, "edited in the worktree\n")
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", reasons: [] })
      assert.strictEqual(yield* fs.readFileString(`${repo}/CLAUDE.md`), "local rules\n")

      const c = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(c.id)}/notes.txt`, "mine\n")
      const out = (yield* c.sessions.remove(c.id))!
      assert.strictEqual(out.worktree, "kept")
      assert.match(out.reasons.join("\n"), /uncommitted changes/)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(c.id)}/notes.txt`), "mine\n")
      assert.isTrue(yield* fs.exists(`${yield* sessionWorktree(c.id)}/CLAUDE.md`))
      yield* fs.remove(`${yield* sessionWorktree(c.id)}/notes.txt`)
      yield* fs.writeFileString(`${yield* sessionWorktree(c.id)}/README.md`, "modified")
      assert.deepInclude((yield* c.sessions.remove(c.id))!, {
        worktree: "kept",
        reasons: ["worktree kept: uncommitted changes"],
      })
    }),
  )

  test(
    "a Send accepted just before vibest rm does not bring the removed session back; its message fails once",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const counts = Effect.all([herdr.callsTo("open"), herdr.callsTo("send")]).pipe(
        Effect.map((calls) => calls.map((c) => c.length)),
      )
      const before = yield* counts
      const held = yield* herdr.hold("state", id)
      const removing = yield* Effect.forkChild(sessions.remove(id, { keepWorktree: true }))
      yield* held.reached
      yield* sessions.send(id, "late")
      yield* held.release()
      assert.deepInclude(yield* Fiber.join(removing), { worktree: "kept" })
      yield* TestClock.withLive(Effect.sleep("100 millis"))
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* counts, before)
      const notices = yield* sqlNotices(id)
      assert.deepStrictEqual(
        notices.filter((m) => m.endsWith("\n\nlate")),
        [`A message to ${id} was not delivered: ${id} was archived before it was delivered\n\nlate`],
      )
      assert.deepInclude(yield* sessions.remove(id), { worktree: "removed" })
    }),
  )

  test(
    "remove closes the session's own pane after its harness exited (a shell left in it); a pane with no process in the worktree no longer keeps it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* herdr.updateAgent(a.id, (x) => ({ ...x, alive: false }))
      assert.deepInclude((yield* a.sessions.remove(a.id))!, {
        pane: "closed",
        workspace: "none",
        worktree: "removed",
        reasons: [],
      })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(a.id)))

      const b = yield* idleSession(repo)
      yield* herdr.updateAgent(b.id, (x) => ({ ...x, alive: false }))
      yield* herdr.addPane("user:3", "elsewhere", yield* sessionWorktree(b.id))
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { pane: "closed", worktree: "removed" })
      assert.isTrue(HashMap.has(yield* herdr.panes, "user:3"))
    }),
  )

  test(
    "a session removed with --keep-worktree is never resumed; rm again removes the worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      assert.deepInclude(yield* sessions.remove(id, { keepWorktree: true }), { worktree: "kept" })
      const starts = (yield* herdr.callsTo("open")).length
      assert.strictEqual(
        (yield* Effect.flip(sessions.send(id, "come back"))).message,
        `${id} was archived; run a new session`,
      )
      yield* sessions.check(id)
      assert.lengthOf(yield* herdr.callsTo("open"), starts)
      assert.deepInclude(yield* sessions.remove(id), { worktree: "removed" })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
    }),
  )

  test(
    "remove of a worktree that is gone, or not this repository's, reconciles its processes and leaves the directory alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* fs.remove(yield* sessionWorktree(a.id), { recursive: true })
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { pane: "closed", workspace: "none", worktree: "gone" })
      assert.isNotNull((yield* a.db.getSession(a.id))!.exitedAt)

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      yield* sh(repo, "worktree", "move", wb, `${wb}-moved`)
      yield* fs.makeDirectory(wb)
      yield* sh(wb, "init", "-q")
      yield* fs.writeFileString(`${wb}/mine.txt`, "the user's")
      const out = (yield* b.sessions.remove(b.id))!
      assert.deepInclude(out, { worktree: "kept" })
      assert.match(out.reasons.join("\n"), /not a worktree of its repository/)
      assert.isTrue(yield* fs.exists(`${wb}/mine.txt`))
    }),
  )

  test(
    "interrupt stops the turn but keeps the session; no result arrives, and the next message goes straight in",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).at(-1)!.keys, ["esc"])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
      yield* sessions.send(id, "do it differently")
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
    }),
  )

  test(
    "vibest interrupt (pi): the aborted turn end its Esc makes is no result, no inbox row and no new round",
    Effect.gen(function* () {
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "pi")
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      const before = yield* roundAndResultCounts(id)
      yield* writeResult(id, "pi", { text: "", error: "aborted", aborted: true }, 60_000)
      yield* TestClock.adjust("2 minutes")
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.turnState, "interrupted")
      assert.isUndefined(yield* db.latestInbox(id, "result"))
      assert.deepStrictEqual(yield* db.coordinatorPending(row.projectId), [])
      assert.deepStrictEqual(yield* roundAndResultCounts(id), before)
      assert.strictEqual(before.results, 0)
    }),
    { hooked: ["pi"] },
  )

  for (const harness of ["claude", "pi"] as const)
    test(
      `remove of a working ${harness} session: the aborted turn end of its interrupt is no result, written during the interrupt or after`,
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const aborted = harness === "claude" ? claudeEnd("aborted") : { text: "", error: "aborted", aborted: true }
        const during = yield* spawnWorking(repo, harness)
        const held = yield* herdr.hold("send", during.id)
        const removing = yield* Effect.forkChild(during.sessions.remove(during.id))
        yield* held.reached
        yield* writeResult(during.id, harness, aborted, 60_000)
        yield* held.release()
        yield* Fiber.join(removing)
        const after = yield* spawnWorking(repo, harness)
        yield* after.sessions.remove(after.id)
        yield* writeResult(after.id, harness, aborted, 60_000)
        yield* TestClock.adjust("2 minutes")
        for (const { id, sessions, db } of [during, after]) {
          const row = (yield* db.getSession(id))!
          assert.isTrue(row.metadata.archived, id)
          yield* sessions.check(id)
          assert.deepStrictEqual(yield* roundAndResultCounts(id), { rounds: 1, results: 0 }, id)
          assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted", id)
          assert.deepStrictEqual(yield* db.coordinatorPending(row.projectId), [])
        }
      }),
      harness === "pi" ? { hooked: ["pi"] } : undefined,
    )

  test(
    "interrupt delivers a result that is already in instead of discarding it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      assert.include((yield* sessions.interrupt(id)).message, "already finished")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).slice(1), [])
      assert.strictEqual((yield* db.coordinatorPending((yield* db.getSession(id))!.projectId))[0]!.kind, "result")
    }),
    { hooked: ["pi"] },
  )

  test(
    "interrupt of an idle session changes nothing",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.include((yield* sessions.interrupt(id)).message, "not working")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "interrupt that does not take: SessionBusy, the round stays open, so the late aborted turn.complete is delivered as an interrupted result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* untilVirtual(
        Effect.sync(() => interrupting.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.strictEqual((yield* Effect.flip(Fiber.join(interrupting)))._tag, "SessionBusy")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* writeResult(id, "claude", claudeEnd("aborted"))
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      assert.include(
        (yield* db.latestInbox(id, "result"))!.message,
        "interrupted: the turn was stopped in its terminal (Esc) before it ended",
      )
    }),
    { interruptIgnored: true },
  )

  test(
    "run --peer shares the worktree; archiving keeps it while another live session works in it, and the last one removes it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const peer = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(peer.id)
      const peerPane = (yield* herdr.agent(peer.id))!.terminal

      const { id } = yield* peer.sessions.spawn({ ...(yield* spawnInput(repo)), peer: peer.id })
      yield* until(peer.db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* peer.sessions.check(id)
      assert.lengthOf(yield* herdr.callsTo("open"), 2)
      const split = (yield* herdr.callsTo("open")).at(-1)!
      assert.strictEqual(split.near, peerPane)
      assert.strictEqual(split.cwd, worktree)
      assert.deepInclude(split.env, { VIBEST_SESSION_ID: id, VIBEST_AGENT: "general" })
      const pane = (yield* herdr.agent(id))!.terminal
      assert.strictEqual(pane.split(":")[0], peerPane.split(":")[0])
      const got = yield* peer.sessions.get(id)
      assert.deepInclude(got, { worktree })
      assert.notProperty(got.metadata, "peer")
      assert.strictEqual(yield* sessionWorktree(id), worktree)
      assert.match(path.basename(worktree), /^[0-9a-f]{4}$/)
      const rules = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(rules, "others may be making changes in this worktree too")
      assert.notInclude(rules, peer.id)
      assert.notInclude(rules, "git switch -c <branch>")

      const third = yield* peer.sessions.spawn({ ...(yield* spawnInput(repo)), peer: id })
      assert.strictEqual(yield* sessionWorktree(third.id), worktree)
      yield* until(peer.db.getSession(third.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      assert.strictEqual((yield* peer.sessions.get(third.id)).worktree, worktree)
      assert.strictEqual((yield* herdr.callsTo("open"))[2]!.near, pane)
      assert.lengthOf(yield* herdr.callsTo("open"), 3)

      const ownerFirst = (yield* peer.sessions.remove(peer.id))!
      assert.deepInclude(ownerFirst, { processes: "exited", pane: "closed", worktree: "kept", path: worktree })
      assert.include(ownerFirst.reasons.join("\n"), id)
      assert.include(ownerFirst.reasons.join("\n"), third.id)
      assert.isTrue(yield* fs.exists(worktree))

      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* peer.sessions.check(id)
      const borrower = (yield* peer.sessions.remove(id))!
      assert.deepInclude(borrower, { processes: "exited", pane: "closed", worktree: "kept", path: worktree })
      assert.include(borrower.reasons.join("\n"), `session ${third.id} still works in it`)
      assert.isFalse(yield* fs.exists(yield* systemPromptFile(id)))
      assert.strictEqual(yield* resultText(id), "")
      assert.isTrue(yield* fs.exists(worktree))

      const ownerSecond = (yield* peer.sessions.remove(peer.id))!
      assert.deepInclude(ownerSecond, { worktree: "kept", path: worktree })
      assert.include(ownerSecond.reasons.join("\n"), third.id)
      assert.notInclude(ownerSecond.reasons.join("\n"), id)
      assert.isTrue(yield* fs.exists(worktree))

      yield* writeResult(third.id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(third.id)
      yield* peer.sessions.check(third.id)
      const last = (yield* peer.sessions.remove(third.id))!
      assert.deepInclude(last, { worktree: "removed", path: worktree })
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )

  test(
    "a resume keeps the owner's git rules beside a --peer; only the --peer gets the peer rules",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* until(owner.db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* owner.sessions.check(id)
      for (const session of [owner.id, id]) {
        yield* herdr.updateAgent(session, (a) => ({ ...a, alive: false }))
        yield* owner.sessions.check(session)
      }
      yield* untilVirtual(owner.sessions.inMemory, (m) => m.tracked === 0 && m.locks === 0)
      for (const session of [owner.id, id]) {
        yield* owner.sessions.send(session, `again ${session}`)
        yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === `again ${session}`))
      }
      assert.include(yield* fs.readFileString(yield* systemPromptFile(owner.id)), "git switch -c <branch>")
      const peerRules = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(peerRules, "others may be making changes in this worktree too")
      assert.notInclude(peerRules, "git switch -c <branch>")
    }),
  )

  test(
    "run --peer refuses a missing, cross-project, archived or ineligible session before it creates a worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const sessions = yield* Sessions
      const db = yield* Db
      const unknown = yield* Effect.flip(
        sessions.spawn({ ...(yield* spawnInput(repo)), peer: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      )
      assert.strictEqual(unknown._tag, "NoSuchSession")
      assert.include(
        unknown.message,
        "--peer ffffffff-ffff-4fff-8fff-ffffffffffff: no session ffffffff-ffff-4fff-8fff-ffffffffffff",
      )

      const { id, row } = yield* spawnWorking(repo)
      const created = () => herdr.callsTo("open").pipe(Effect.map((calls) => calls.length))
      const before = yield* created()
      const otherRepo = yield* makeRepository
      const cross = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(otherRepo)), peer: id }))
      assert.include(cross.message, "belongs to another project")
      const address = (yield* db.getSession(id))!.address
      yield* db.updateSession(id, { address: { ...address, machine: "other" } })
      const otherSession = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(otherSession.message, "ineligible")
      yield* db.updateSession(id, { address })
      const worktree = yield* sessionWorktree(id)
      yield* fs.rename(worktree, `${worktree}.away`)
      const gone = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(gone.message, "ineligible")
      assert.include(gone.message, "gone")
      yield* fs.rename(`${worktree}.away`, worktree)
      yield* db.updateSession(id, { metadata: { ...row.metadata, archived: true, removed: true } })
      const archived = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(archived.message, "it was archived")
      assert.strictEqual(yield* created(), before)
      assert.isUndefined(yield* db.getSession("ffffffff-ffff-4fff-8fff-ffffffffffff"))
    }),
  )

  const started: Array<string> = []
  test(
    "agent.start runs before both run and run --peer start a session",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      started.length = 0
      const owner = yield* idleSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), prompt: "peer task", peer: owner.id })
      assert.deepStrictEqual(started, [`${repo}: do it`, `${repo}: peer task`])
      assert.strictEqual(owner.row.model, "fake-strong")
      assert.strictEqual((yield* owner.db.getSession(id))!.model, "fake-strong")
    }),
    {
      plugins: [
        {
          id: "seen",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                started.push(`${e.project}: ${e.prompt}`)
                e.model = "fake-strong"
              }),
            ),
        },
      ],
    },
  )

  const peersSharingDirectory = (ownerId: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      const shared = yield* db.sessionDirectory(ownerId)
      return yield* Effect.filter(
        (yield* db.listSessions({ stopped: true })).filter((s) => s.id !== ownerId),
        (s) => db.sessionDirectory(s.id).pipe(Effect.map((d) => d === shared)),
      )
    })

  const parkAdmitBeforeInsert = Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const go = yield* Deferred.make<void>()
    peerAdmitPause.wait = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(go)))
    return { reached: Deferred.await(reached), release: Deferred.succeed(go, undefined).pipe(Effect.asVoid) }
  })

  test(
    "owner archive cannot delete a clean worktree while run --peer is admitted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        peerAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id }))
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(peersSharingDirectory(owner.id), (rows) => rows.length === 1)
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          const exists = yield* fs.exists(worktree)
          assert.fail(
            "archive listed no borrower then removed the tree after admit: worktree=" +
              archived.worktree +
              " exists=" +
              String(exists),
          )
        }
        assert.deepStrictEqual(yield* peersSharingDirectory(owner.id), [])
        assert.isUndefined(archiving.pollUnsafe())
        yield* parked.release
        yield* until(peersSharingDirectory(owner.id), (rows) => rows.length === 1)
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), (yield* peersSharingDirectory(owner.id))[0]!.id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a borrower admitted before archive keeps the clean worktree while its launch is still in herdr",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const split = yield* herdr.hold("open")
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id }))
        yield* split.reached
        const admitted = yield* Fiber.join(spawning)
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        yield* until(
          Effect.sync(() => archiving.pollUnsafe()),
          (exit) => exit !== undefined,
        )
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), admitted.id)
        assert.isTrue(yield* fs.exists(worktree))
      }).pipe(Effect.ensuring(split.release().pipe(Effect.ignore)))
      yield* until(
        owner.db.getSession((yield* peersSharingDirectory(owner.id))[0]!.id),
        (w) => !!w && (w.startedAt !== null || w.exitedAt !== null),
      )
    }),
  )

  test(
    "run --peer of an exited session takes the directory's lock, so another archive cannot delete the shared tree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const mid = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* until(owner.db.getSession(mid.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      const midPane = (yield* herdr.agent(mid.id))!.terminal
      yield* herdr.runtime.close({ machine: "local", id: midPane })
      yield* owner.db.updateSession(mid.id, { status: "unknown", exitedAt: 1 })
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        peerAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: mid.id }))
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(peersSharingDirectory(owner.id), (rows) =>
            rows.some((s) => s.id !== mid.id && s.exitedAt === null),
          )
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          assert.fail(
            "owner archive listed before peer-of-peer insert and removed the tree: worktree=" + archived.worktree,
          )
        }
        yield* parked.release
        yield* until(peersSharingDirectory(owner.id), (rows) => rows.some((s) => s.id !== mid.id))
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a failed peer launch closes only the new split pane and leaves the owner's pane and worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const ownerPane = (yield* herdr.agent(owner.id))!.terminal
      const closesBefore = (yield* herdr.callsTo("close")).map((c) => c.terminal)
      const created = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open")
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* held.reached
      yield* held.release("failed")
      yield* until(owner.db.getSession(id), (w) => !!w && w.exitedAt !== null)
      const newCloses = (yield* herdr.callsTo("close"))
        .map((c) => c.terminal)
        .filter((pane) => !closesBefore.includes(pane))
      assert.deepStrictEqual(newCloses, [])
      assert.isTrue(HashMap.has(yield* herdr.panes, ownerPane))
      assert.isTrue(yield* fs.exists(worktree))
      assert.strictEqual((yield* herdr.callsTo("open")).length, created + 1)
      assert.strictEqual(yield* owner.db.sessionDirectory(id), yield* owner.db.sessionDirectory(owner.id))
    }),
  )
})

let pauseAfterResultRead:
  | { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  | undefined
let archiveStartedSignal: { readonly id: string; readonly done: Deferred.Deferred<void> } | undefined
const gated: TestOptions = {
  db: (db) => ({
    ...db,
    latestInbox: (id, kind) =>
      db.latestInbox(id, kind).pipe(
        Effect.tap(() => {
          const gate = kind === "result" ? pauseAfterResultRead : undefined
          if (!gate) return Effect.void
          pauseAfterResultRead = undefined
          return Deferred.succeed(gate.reached, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
        }),
      ),
    getSession: (id) =>
      db.getSession(id).pipe(
        Effect.tap(() => {
          const gate = archiveStartedSignal?.id === id ? archiveStartedSignal : undefined
          if (!gate) return Effect.void
          archiveStartedSignal = undefined
          return Deferred.succeed(gate.done, undefined)
        }),
      ),
  }),
}

describe.concurrent("vibest run --archive-on-completion", () => {
  const archiveSession = (
    repo: string,
    coordinator: "claude" | "pi" = "claude",
    input: { readonly peer?: string } = {},
  ) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      yield* db.coordinatorLaunch(yield* projectOf(repo), coordinator, false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* herdr.seedAgent("test/coord")
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), ...input, archive: true })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* settled
      return { id, sessions, db, herdr, projectId: (yield* db.getSession(id))!.projectId }
    })

  const finishTurn = (
    w: { readonly id: string; readonly sessions: Sessions["Service"]; readonly herdr: FakeRuntime["Service"] },
    text: string,
    error?: string,
  ) =>
    Effect.gen(function* () {
      yield* writeResult(w.id, "pi", error ? { text, error } : { text })
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
    })

  const ackResult = (w: { readonly projectId: string }) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const polled = yield* until(inbox.poll(w.projectId), (r) => r.ids.length > 0)
      return yield* inbox.ack(w.projectId, polled.ids)
    })

  const archived = (db: Db["Service"], id: string) => db.getSession(id).pipe(Effect.map((w) => !!w?.metadata.archived))
  const letForkedArchiveRun = TestClock.withLive(Effect.sleep("100 millis"))
  const latestNotice = (id: string) => sqlNotices(id).pipe(Effect.map((n) => n.at(-1) ?? ""))

  test(
    "a completed result the main agent acked archives the session; a clean archive sends no notice (nothing to do); vibest result still works",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const w = yield* archiveSession(yield* makeRepository)
      assert.isTrue((yield* w.db.getSession(w.id))!.metadata.archive)
      yield* finishTurn(w, "status: completed\nsummary: found it")
      yield* ackResult(w)
      yield* until(archived(w.db, w.id), (a) => a)
      yield* until(fs.exists(yield* sessionWorktree(w.id)), (e) => !e)
      yield* until(w.db.getSession(w.id), (r) => r!.exitedAt !== null)
      yield* letForkedArchiveRun
      const rows = yield* sql<{
        kind: string
        status: string
      }>`SELECT CASE WHEN m.kind = 'result' THEN 'result' WHEN m.kind = 'notice' THEN 'notice' WHEN m.kind IN ('report', 'result') THEN 'report' ELSE 'send' END AS kind, m.status AS status FROM inbox m WHERE m.sender_session_id = ${w.id} ORDER BY m.id`.pipe(
        Effect.orDie,
      )
      assert.deepStrictEqual(
        rows.map((r) => r.kind),
        ["result"],
      )
      assert.strictEqual(rows[0]!.status, "delivered")
      assert.include((yield* w.db.latestInbox(w.id, "result"))!.message, "found it")
      assert.isNotNull((yield* w.db.getSession(w.id))!.exitedAt)
    }),
  )

  test(
    "a Pi coordinator: archived once the extension acked the result (its next pull), and a clean archive sends it no batch",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const w = yield* archiveSession(yield* makeRepository, "pi")
      yield* finishTurn(w, "status: completed")
      assert.isFalse(yield* archived(w.db, w.id))
      const batches: Array<string> = []
      const pulling = yield* Effect.forkChild(
        inbox.stream(w.projectId).pipe(
          Stream.take(2),
          Stream.runForEach((b) => Effect.sync(() => batches.push(b))),
        ),
      )
      yield* until(archived(w.db, w.id), (a) => a)
      yield* letForkedArchiveRun
      yield* Fiber.interrupt(pulling)
      assert.lengthOf(batches, 1)
      assert.include(batches[0]!, "<agent-result")
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.strictEqual(yield* inbox.locks, 0)
      yield* untilVirtual((yield* Sessions).inMemory, (m) => m.tracked === 0 && m.locks === 0)
    }),
  )

  test(
    "a Claude coordinator polling its inbox: archived once it acked the batch holding the result",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const coord = yield* db.coordinatorLaunch(yield* projectOf(repo), "claude", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", "claude-1")
      yield* herdr.seedAgent("test/coord")
      const projectId = yield* projectOf(repo)
      const sessions = yield* Sessions
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), archive: true })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* finishTurn({ id, sessions, herdr }, "status: completed")
      const polled = yield* until(inbox.poll(projectId), (r) => r.ids.length > 0)
      yield* letForkedArchiveRun
      assert.isFalse(yield* archived(db, id))
      assert.deepStrictEqual(yield* inbox.ack(projectId, polled.ids), polled.ids)
      yield* until(archived(db, id), (a) => a)
    }),
  )

  slowTest(
    "not archived while the result is only queued, when its poll lease is released or it is dropped, or when the Pi extension never acked it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const inbox = yield* Inbox
      const a = yield* archiveSession(repo)
      yield* finishTurn(a, "status: completed")
      yield* letForkedArchiveRun
      assert.strictEqual((yield* a.db.latestInbox(a.id, "result"))!.status, "pending")
      assert.isFalse(yield* archived(a.db, a.id))
      const polled = yield* inbox.poll(a.projectId)
      assert.lengthOf(polled.ids, 1)
      assert.deepStrictEqual(yield* inbox.ack(a.projectId, [], polled.ids), [])
      yield* letForkedArchiveRun
      assert.strictEqual((yield* a.db.latestInbox(a.id, "result"))!.status, "pending")
      assert.isFalse(yield* archived(a.db, a.id))
      const b = yield* archiveSession(repo)
      yield* b.herdr.updateAgent("test/coord", (c) => ({ ...c, alive: false }))
      yield* finishTurn(b, "status: completed")
      yield* until(b.db.latestInbox(b.id, "result"), (r) => r?.status === "dropped")
      yield* letForkedArchiveRun
      assert.isFalse(yield* archived(b.db, b.id))
      const c = yield* archiveSession(repo, "pi")
      yield* finishTurn(c, "status: completed")
      yield* inbox.stream(c.projectId).pipe(Stream.take(1), Stream.runDrain)
      yield* letForkedArchiveRun
      assert.strictEqual((yield* c.db.latestInbox(c.id, "result"))!.status, "failed")
      assert.isFalse(yield* archived(c.db, c.id))
    }),
  )

  test(
    "never after a failed turn, whose summary is the error; the flag stays, so the next completed result archives it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const b = yield* archiveSession(repo)
      yield* finishTurn(b, "status: failed\nsummary: tests fail", "model_error")
      yield* ackResult(b)
      const row = yield* b.db.latestInbox(b.id, "result")
      assert.strictEqual(row!.status, "delivered")
      assert.match(String(row!.details.summary), /^Agent ".*" failed: model_error$/)
      assert.include(row!.message, "<result>\nstatus: failed\nsummary: tests fail")
      yield* letForkedArchiveRun
      assert.isFalse(yield* archived(b.db, b.id))
      yield* b.sessions.send(b.id, "the first one")
      yield* until(b.db.getSession(b.id), (w) => w?.turnState === "open")
      yield* finishTurn(b, "status: completed")
      yield* ackResult(b)
      yield* until(archived(b.db, b.id), (x) => x)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a message queued when the result is delivered: not archived, no notice (nothing to do), and the message is delivered",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* w.sessions.send(w.id, "one more thing")
      yield* finishTurn(w, "status: completed")
      yield* ackResult(w)
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.isFalse(yield* archived(w.db, w.id))
      yield* w.sessions.check(w.id)
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "a message accepted while the archive runs wins: not archived, not failed, delivered",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* finishTurn(w, "status: completed")
      const held = yield* w.herdr.hold("state", w.id)
      yield* ackResult(w)
      yield* held.reached
      yield* w.sessions.send(w.id, "one more thing")
      yield* held.release()
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.isFalse(yield* archived(w.db, w.id))
      assert.lengthOf(yield* w.db.inboxWithStatus(w.id, "failed"), 0)
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "the session turns busy after it went idle (the user typed in its pane): refused before the tombstone, still unarchived and usable",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* finishTurn(w, "status: completed")
      yield* settled
      const get = yield* w.herdr.hold("state", w.id, 2)
      yield* ackResult(w)
      yield* get.reached
      yield* w.herdr.updateAgent(w.id, (a) => ({ ...a, status: "working" }))
      yield* get.release()
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.deepStrictEqual(
        (yield* w.herdr.callsTo("send")).filter((call) => call.keys !== undefined),
        [],
      )
      const row = (yield* w.db.getSession(w.id))!
      assert.isUndefined(row.metadata.archived)
      assert.isUndefined(row.metadata.removed)
      assert.lengthOf(yield* w.herdr.callsTo("close"), 0)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.send(w.id, "next")
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "a message sent once it decided to archive is refused, never accepted and then failed",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const w = yield* archiveSession(yield* makeRepository)
      const held = yield* fake.holdCwd()
      yield* finishTurn(w, "status: completed")
      yield* ackResult(w)
      yield* held.reached
      assert.strictEqual(
        (yield* Effect.flip(w.sessions.send(w.id, "too late"))).message,
        `${w.id} was archived; run a new session`,
      )
      yield* held.release()
      yield* until(w.db.getSession(w.id), (r) => r!.exitedAt !== null)
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* w.db.inboxWithStatus(w.id, "failed"), [])
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
  )

  test(
    "Send's insert and the archive decision are one transaction each: whichever commits first wins",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const a = yield* archiveSession(repo)
      assert.isDefined(yield* a.db.insertSend(a.id, "first"))
      assert.isFalse(yield* a.db.archiveIfNoPending(a.id))
      assert.isFalse(yield* archived(a.db, a.id))
      const b = yield* archiveSession(repo)
      assert.isTrue(yield* b.db.archiveIfNoPending(b.id))
      assert.isUndefined(yield* b.db.insertSend(b.id, "late"))
      assert.deepStrictEqual(yield* b.db.pendingInbox(b.id), [])
    }),
  )

  test(
    "its harness already exited: not archived, and the notice says to archive it by hand",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* writeResult(w.id, "pi", { text: "status: completed" })
      yield* w.herdr.updateAgent(w.id, (a) => ({ ...a, alive: false }))
      yield* w.sessions.check(w.id)
      yield* ackResult(w)
      yield* until(latestNotice(w.id), (m) => m.includes("not archived"))
      assert.include(yield* latestNotice(w.id), "its harness already exited")
      assert.isFalse(yield* archived(w.db, w.id))
    }),
  )

  const firstArchiveWaiting = (
    w: Effect.Success<ReturnType<typeof archiveSession>>,
    details: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      yield* finishTurn(w, "status: completed\nsummary: first")
      yield* settled
      const check = yield* w.herdr.hold("state", w.id)
      const checking = yield* Effect.forkChild(w.sessions.check(w.id))
      yield* check.reached
      const looked = yield* awaitArchiveStart(w.id)
      yield* ackResult(w)
      assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
      yield* looked
      yield* w.db.finishTurn(
        w.id,
        { status: "completed" },
        { turnState: "completed", status: "idle" },
        { sessionId: w.id, kind: "result", message: "second", details },
      )
      return { release: check.release().pipe(Effect.andThen(Fiber.join(checking))) }
    })

  const awaitArchiveStart = (id: string) =>
    Deferred.make<void>().pipe(
      Effect.map((done) => {
        archiveStartedSignal = { id, done }
        return Deferred.await(done)
      }),
    )

  const assertArchivesDone = (w: Effect.Success<ReturnType<typeof archiveSession>>) =>
    Effect.gen(function* () {
      const sends = (yield* w.herdr.callsTo("send")).length
      yield* w.sessions.check(w.id)
      assert.lengthOf(yield* w.herdr.callsTo("send"), sends)
    })

  test(
    "a newer completed result delivered while the first one's archive waits for the lock: archived once, no notice",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      const first = yield* firstArchiveWaiting(w, { status: "completed", summary: "second" })
      const looked = yield* awaitArchiveStart(w.id)
      yield* ackResult(w)
      assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
      yield* looked
      yield* first.release
      yield* until(archived(w.db, w.id), (a) => a)
      yield* assertArchivesDone(w)
      assert.lengthOf(yield* w.herdr.callsTo("close"), 1)
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
    gated,
    true,
  )

  test(
    "a newer result still being sent when the waiting archive reads it: archived once it is acked; never when its lease is released",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const repo = yield* makeRepository
      for (const released of [false, true]) {
        const w = yield* archiveSession(repo)
        const first = yield* firstArchiveWaiting(w, { status: "completed", summary: "second" })
        const polled = yield* inbox.poll(w.projectId)
        assert.lengthOf(polled.ids, 1)
        const read = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        pauseAfterResultRead = read
        yield* first.release
        yield* Deferred.await(read.reached)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "sending")
        const looked = yield* awaitArchiveStart(w.id)
        yield* inbox.ack(w.projectId, released ? [] : polled.ids, released ? polled.ids : [])
        if (!released) {
          assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
          yield* looked
        }
        yield* Deferred.succeed(read.release, undefined)
        if (!released) {
          yield* until(archived(w.db, w.id), (a) => a)
          yield* assertArchivesDone(w)
          assert.deepStrictEqual(yield* sqlNotices(w.id), [])
          continue
        }
        archiveStartedSignal = undefined
        yield* assertArchivesDone(w)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "pending")
        assert.isFalse(yield* archived(w.db, w.id))
      }
    }),
    gated,
    true,
  )

  test(
    "the newer delivered result is failed, a message waits, or a new turn began: the waiting archive does not archive on it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      for (const newer of ["failed", "message", "turn"]) {
        const w = yield* archiveSession(repo)
        const completed = newer === "message" || newer === "turn"
        const first = yield* firstArchiveWaiting(w, { status: completed ? "completed" : newer })
        if (newer === "message") assert.isDefined(yield* w.db.insertSend(w.id, "one more thing"))
        if (newer === "turn") yield* w.db.updateSession(w.id, { turnState: "open" })
        const looked = completed ? yield* awaitArchiveStart(w.id) : Effect.void
        yield* ackResult(w)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
        yield* looked
        yield* first.release
        yield* assertArchivesDone(w)
        assert.isFalse(yield* archived(w.db, w.id), newer)
        assert.isUndefined((yield* w.db.getSession(w.id))!.metadata.removed, newer)
        if (newer === "message") {
          assert.lengthOf(yield* w.db.inboxWithStatus(w.id, "failed"), 0)
          assert.lengthOf(yield* w.db.inboxWithStatus(w.id, "delivered"), 1)
        }
      }
    }),
    gated,
    true,
  )

  test(
    "an owner started with --archive-on-completion keeps its worktree while a borrower is live",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* archiveSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* until(owner.db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* finishTurn(owner, "status: completed")
      yield* ackResult(owner)
      const notice = yield* until(latestNotice(owner.id), (m) => m.includes("archived ("))
      assert.include(notice, `worktree kept: session ${id} still works in it`)
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(owner.id)))
    }),
  )

  test(
    "run --peer: --keep-worktree keeps the directory at that archive only; the last session's archive removes it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const b = yield* archiveSession(repo, "claude", { peer: owner.id })
      const worktree = yield* sessionWorktree(owner.id)
      assert.include(
        (yield* owner.sessions.remove(owner.id, { keepWorktree: true }))!.reasons.join("\n"),
        "--keep-worktree",
      )
      const out = (yield* b.sessions.remove(b.id))!
      assert.strictEqual(out.worktree, "removed")
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )
})

const nextVibestd = (done: Effect.Effect<boolean, never, TestServices>) =>
  Effect.gen(function* () {
    const next = yield* Sessions.make({ maxSessions: undefined })
    yield* until(done, (yes) => yes)
    yield* until(next.inMemory, (m) => m.locks === 0)
  })

const heldAtOpen = <A, E, R, R2>(
  target: string | undefined,
  start: Effect.Effect<unknown, never, R2>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const held = yield* (yield* FakeRuntime).hold("open", target)
    yield* start
    yield* held.reached
    return yield* body.pipe(Effect.ensuring(held.release("unreachable")))
  })

describe.concurrent("after a vibestd stop", () => {
  const cutOffSpawn = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const spawned = yield* Deferred.make<string>()
      return yield* heldAtOpen(
        undefined,
        Effect.flatMap(Sessions, (sessions) =>
          spawnInput(repo).pipe(
            Effect.flatMap(sessions.spawn),
            Effect.flatMap(({ id }) => Deferred.succeed(spawned, id)),
            Effect.orDie,
          ),
        ),
        Effect.flatMap(Deferred.await(spawned), body),
      )
    })

  test(
    "a spawn cut off before its terminal ends launch_failed, its worktree removed, with one notice",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const db = yield* Db
        const worktree = yield* sessionWorktree(id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isFalse(yield* fs.exists(worktree))
        assert.deepStrictEqual(yield* sqlNotices(id), [
          `${id} never finished starting (vibestd stopped while it started); its worktree was removed.`,
        ])
        assert.deepInclude(yield* db.getSession(id), { startedAt: null, status: "unknown" })
      }),
    ),
  )

  test(
    "a spawn cut off before its terminal keeps its worktree while a process works in it, and names it",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* (yield* FakeProcesses).setCwdUsers([4242])
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
        const [text] = yield* sqlNotices(id)
        assert.include(text!, "never finished starting (vibestd stopped while it started)")
        assert.include(text!, "process 4242 has its working directory in it")
      }),
    ),
  )

  test(
    "a resume cut off before its terminal falls back to its previous start and keeps its worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const before = (yield* db.getSession(id))!
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* heldAtOpen(
        id,
        sessions.send(id, "next").pipe(Effect.orDie),
        Effect.gen(function* () {
          assert.isNull((yield* db.getSession(id))!.startedAt)
          const cutOff = (texts: ReadonlyArray<string>) => texts.find((t) => t.includes("never finished starting"))
          yield* nextVibestd(Effect.map(sqlNotices(id), (n) => cutOff(n) !== undefined))
          assert.deepStrictEqual(yield* processEnds(id), ["exited", "launch_failed"])
          const after = (yield* db.getSession(id))!
          assert.deepStrictEqual([after.address, after.startedAt], [before.address, before.startedAt])
          assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
          assert.strictEqual(
            cutOff(yield* sqlNotices(id)),
            `${id} never finished starting (vibestd stopped while it started).`,
          )
        }),
      )
    }),
    { hooked: ["pi"] },
  )

  const waitingForReady = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const opening = yield* herdr.hold("open")
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(repo))
      yield* opening.reached
      const looking = yield* herdr.hold("state", id)
      yield* opening.release()
      yield* looking.reached
      return yield* body(id).pipe(Effect.ensuring(looking.release("unreachable")))
    })

  const turnInputs = (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ input: string; status: string }>`SELECT input, status FROM ${sql.literal(TURNS)} m
        WHERE session_id = ${id} ORDER BY id`.pipe(Effect.orDie),
    )
  const typed = (text: string) =>
    Effect.map(
      Effect.flatMap(FakeRuntime, (herdr) => herdr.callsTo("send")),
      (calls) => calls.filter((c) => c.text === text).length,
    )

  test(
    "a first turn ended before its handover (vibestd stopped in its ready wait) leaves the task for the next vibestd",
    waitingForReady((id) =>
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.updateSession(id, { turnState: "not_started" })
        assert.strictEqual(yield* db.untakenTask(id), "do it")
        yield* nextVibestd(Effect.map(typed("do it"), (n) => n === 1))
        assert.deepStrictEqual(yield* turnInputs(id), [
          { input: "", status: "not_started" },
          { input: "do it", status: "working" },
        ])
        assert.isUndefined(yield* db.untakenTask(id))
      }),
    ),
    { hooked: ["pi"] },
  )

  test(
    "a task handed over at reconcile that does not start ends the turn not_started and is not handed over again",
    waitingForReady((id) =>
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        yield* Ref.set(herdr.skipPromptUpdates, 2)
        const next = yield* Sessions.make({ maxSessions: undefined })
        yield* untilVirtual(turnInputs(id), (turns) => turns[0]?.status === "not_started")
        assert.strictEqual(yield* typed("do it"), 2)
        assert.isTrue((yield* sqlNotices(id)).some((t) => t.startsWith("task_not_started")))
        yield* next.check(id)
        yield* until(next.inMemory, (m) => m.locks === 0)
        assert.strictEqual(yield* typed("do it"), 2)
        assert.strictEqual((yield* turnInputs(id)).length, 1)
      }),
    ),
    { hooked: ["pi"] },
  )

  const deliveredNotArchived = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const w = yield* idleSession(yield* makeRepository)
    yield* sql`UPDATE session SET archive_on_completion = 1 WHERE id = ${w.id}`.pipe(Effect.orDie)
    const result = (yield* w.db.latestInbox(w.id, "result"))!
    assert.strictEqual(result.details.status, "completed")
    yield* w.db.setInboxStatus([result.id], "delivered")
    return w
  })

  test(
    "a session with archive-on-completion that has a message pending is left to it by the next vibestd",
    Effect.gen(function* () {
      const { id, db } = yield* deliveredNotArchived
      const sent = (yield* db.insertSend(id, "more"))!
      yield* nextVibestd(Effect.map(db.inboxWithStatus(id, "pending"), (rows) => !rows.some((r) => r.id === sent.id)))
      yield* settled
      assert.isUndefined((yield* db.getSession(id))!.metadata.archived)
    }),
    { hooked: ["pi"] },
  )
})
