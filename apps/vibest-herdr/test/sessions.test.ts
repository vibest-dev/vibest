// Session state machine against a fake herdr (SPEC §15: "State machine response to event sequences").
// `it.effect` runs on TestClock: time stands still unless a test moves it, so polls and timeouts only fire on purpose.
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import type { HarnessId } from "@vibest/core/harness"
import { claude } from "@vibest/core/harnesses/claude"
import { Inbox } from "@vibest/core/inbox"
import { Layout, worktreePath } from "@vibest/core/paths"
import { AgentRefused } from "@vibest/core/plugins"
import { peerAdmitPause, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { repositoryKey } from "@vibest/core/worktree"
import { AgentRefused as PluginRefused, Plugin } from "@vibest/plugin"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  HashMap,
  Path,
  PlatformError,
  PubSub,
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
  sh,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeResult,
} from "./fakes.ts"

/** Which harness an `open` argv starts: its binary, first. */
const harnessOf = (argv: ReadonlyArray<string>) => (argv[0] === "cursor-agent" ? "cursor" : argv[0])

const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(
    repositoryKey(repo),
    (key) => ({ machine: { id: "local" }, root: repo, key, name: "task", prompt: "do it", harness }) as const,
  )

/** The result payload `vibest integration stop` writes for the Claude plugin's turn.complete with `reason`. */
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
    yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    })
    const { id } = yield* sessions.spawn(yield* spawnInput(repo, harness))
    yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
    // check takes the session's lock, so this waits for the launch (prompt + confirm) to finish.
    yield* sessions.check(id)
    const row = (yield* db.getSession(id))!
    return { id, row, sessions, db }
  })

/** A session whose first turn is over: idle, nothing queued. */
const idleSession = (repo: string) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const w = yield* spawnWorking(repo)
    yield* writeResult(w.id, "pi", { text: "status: completed" })
    yield* herdr.endTurn(w.id)
    yield* w.sessions.check(w.id)
    return w
  })

/** The directory the row records: its owner's group, or the flat path when the owner has none. */
const sessionWorktree = (id: string) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const row = (yield* (yield* Db).getSession(id))!
    const owner = row.metadata.peer === undefined ? row : (yield* (yield* Db).getSession(row.metadata.peer))!
    const located = worktreePath(layout, owner)
    if (located === undefined) return yield* Effect.die(`no worktree for ${id}`)
    return located
  })

/** An Effect test over a fresh testLayer. `sequential` stays out of a concurrent describe: it touches a process-wide test seam. */
const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
  sequential = false,
) =>
  it.effect(
    name,
    () => program.pipe(Effect.provide(testLayer(options))),
    sequential ? { concurrent: false } : undefined,
  )

/** The archive-on-completion tests run three spawns-heavy sessions; a loaded full-suite run needs more than the default 30 s. */
const slowTest = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(testLayer(options))), { timeout: 90_000 })

const pick = (w: { readonly status: string; readonly turnState: string } | undefined) => ({
  status: w?.status,
  turnState: w?.turnState,
})
/** A session's rounds (message rows) and the result rows it sent to the inbox. */
const countRows = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [rounds] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM message WHERE session_id = ${sessionId}`.pipe(
      Effect.orDie,
    )
    const [results] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM inbox WHERE sender_id = ${sessionId} AND result_message_id IS NOT NULL`.pipe(
      Effect.orDie,
    )
    return { rounds: rounds!.n, results: results!.n }
  })
const sqlNotices = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      message: string
    }>`SELECT m.content AS message FROM inbox m WHERE m.sender_type = 'system' AND m.sender_id = ${sessionId} ORDER BY m.id`.pipe(
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
      assert.match(id, /^[a-f0-9]{8}$/)
      assert.strictEqual(row.status, "working")
      assert.strictEqual(row.turnState, "open")

      const wt = yield* sessionWorktree(id)
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      assert.strictEqual(yield* sh(repo, "branch", "--list", "herdr-*"), "")
      // No .worktreeinclude: makeRepository's untracked CLAUDE.md stays in the main checkout.
      assert.isFalse(yield* fs.exists(path.join(wt, "CLAUDE.md")))
      assert.strictEqual(yield* sh(wt, "status", "--porcelain"), "")
      // vibest's own detached worktree, opened into a terminal of its own beside the main agent's.
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.deepStrictEqual([placed.project, placed.cwd], [repo, wt])
      assert.deepInclude(placed.env, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: id, VIBEST_HOME: layout.home })
      // The project's own scratch directory, the one place under projects the session's guard allows.
      assert.strictEqual(placed.env.VIBEST_SCRATCH, layout.scratch(yield* repositoryKey(repo)))
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      const start = (yield* herdr.callsTo("open"))[0]!
      assert.strictEqual(start.env.VIBEST_SESSION_ID, id)
      assert.deepStrictEqual(start.argv, [
        "pi",
        "--session-id",
        row.harnessSessionId!,
        "--append-system-prompt",
        layout.rulesFile(id),
        "-e",
        "/vibest/harnesses/pi/extension.mjs",
      ])
      assert.include(yield* fs.readFileString(layout.rulesFile(id)), `You are agent ${id}`)
      assert.strictEqual((yield* herdr.callsTo("send"))[0]!.text, "do it")
    }),
  )

  test(
    "hook result + ResultReady ends the turn and becomes a result row for the owner",
    Effect.gen(function* () {
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "\nDone it.\nstatus: failed\n\n## Remember\nuse bun" })
      yield* sessions.resultReady(id)
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")
      assert.strictEqual(w.turnState, "completed")
      const row = yield* db.latestInbox(id, "result")
      assert.strictEqual(row!.kind, "result")
      assert.include(
        row!.message,
        `<agent-result>\n<agent-id>${id}</agent-id>\n<status>completed</status>\n<summary>Done it.</summary>\n<harness>pi</harness>\n<worktree>`,
      )
      // The final message verbatim, nothing parsed out of it.
      assert.include(row!.message, "<result>\n\nDone it.\nstatus: failed\n\n## Remember\nuse bun\n</result>")
      assert.deepInclude(row!.details, { status: "completed", summary: "Done it.", remember: "use bun" })
    }),
    { hooked: ["pi"] },
  )

  test(
    "herdr's push of a status change runs the check: no poll, no ResultReady",
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
    "ResultReady for an unknown session is ignored",
    Effect.gen(function* () {
      yield* (yield* Sessions).resultReady("ffffffff")
    }),
  )

  test(
    "a typed round ends like any round: one result to the parent; typing during an open round records nothing",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* spawnWorking(repo)
      const main = (yield* sql<{ id: string }>`SELECT main_session_id AS id FROM project`)[0]!.id
      const results = () =>
        sql<{
          recipient: string
          sender: string | null
          input: string
          output: string | null
          inbox: number | null
        }>`SELECT i.recipient_session_id AS recipient,
            i.sender_id AS sender, m.input, m.output, m.inbox_id AS inbox
          FROM inbox i JOIN message m ON m.id = i.result_message_id ORDER BY i.id`.pipe(Effect.orDie)

      yield* sessions.userPrompt(main, "hello")
      // vibest opened the task's round before handing it over: the pane's echo, or anything typed now, is not a round.
      yield* sessions.userPrompt(id, "do it")
      yield* sessions.userPrompt(id, "and this")
      const working = yield* sql<{
        input: string
        inbox: number | null
      }>`SELECT input, inbox_id AS inbox FROM message WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(
        working.map((row) => [row.input, row.inbox !== null]),
        [["do it", true]],
      )
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: done it" })
      yield* sessions.resultReady(id)
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.turnState !== "open")

      const input = "a".repeat(2001)
      yield* sessions.userPrompt(id, input)
      const open = yield* sql<{
        input: string
        inbox: number | null
        status: string
      }>`SELECT input, inbox_id AS inbox, status FROM message
        WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(open, [{ input, inbox: null, status: "working" }])
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: typed" })
      yield* sessions.resultReady(id)
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
      assert.deepStrictEqual(yield* sql`SELECT id FROM inbox WHERE sender_type = 'system'`.pipe(Effect.orDie), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "spawn with no harness any plugin could run is refused with each harness's problem",
    Effect.gen(function* () {
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))).pipe(
        Effect.filterOrFail(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          () => new Error("not refused"),
        ),
      )
      assert.deepInclude(refused, { plugin: "harness-choice" })
      assert.include(refused.reason, "no harness available: pi: vibest's pi plugin is missing")
      assert.include(refused.reason, "claude: vibest's claude plugin is missing")
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
      // The result is kept even when the coordinator pane is not in FakeRuntime and delivery drops it.
      const row = yield* db.latestInbox(id, "result")
      assert.include(row!.message, "<status>failed</status>")
      assert.include(row!.message, "the turn ended without a report")
      // No final message: the summary is vibest's own outcome.
      assert.include(row!.message, `<summary>Agent "task" failed: the turn ended without a report`)
      assert.include(row!.message, `to see its terminal, run: vibest peek ${id}`)
      // The fake runtime's screen ("pane tail") is never in what an agent gets.
      assert.notInclude(row!.message, "pane tail")
      assert.notInclude(row!.message, "terminal tail")
    }),
  )

  test(
    "Session process exits mid-turn: failed result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { status: "unknown", turnState: "failed" })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      const [row] = yield* db.coordinatorPending((yield* db.getSession(id))!.projectId)
      assert.include(row!.message, "<status>failed</status>")
      assert.include(row!.message, "the session exited (its terminal is gone or its process with it)")
      assert.notInclude(row!.message, "pane tail")
    }),
  )

  test(
    "a session's in-memory flags, lock and live status go once it ends; resumed, its next turn ends as any turn does; archived, they go again",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      assert.deepStrictEqual(yield* sessions.inMemory, { tracked: 1, locks: 0 })
      assert.strictEqual(yield* db.liveStatuses, 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      // Concurrent checks, as the poll and a runtime event run them: none leaves a lock or the flags behind.
      yield* Effect.all([sessions.check(id), sessions.check(id), sessions.check(id)], { concurrency: "unbounded" })
      assert.deepInclude(yield* db.getSession(id), { turnState: "failed" })
      assert.deepStrictEqual(yield* sessions.inMemory, { tracked: 0, locks: 0 })
      assert.strictEqual(yield* db.liveStatuses, 0)
      // Nothing of the dropped flags is missed: the next message resumes it and its turn is collected.
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { turnState: "open", exitedAt: null })
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: again" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { turnState: "completed" })
      assert.strictEqual((yield* db.latestInbox(id, "result"))!.details.summary, "again")
      // A live session between turns keeps its flags; archived, they go with the next check.
      assert.strictEqual((yield* sessions.inMemory).tracked, 1)
      assert.deepInclude(yield* db.getSession(id), { status: "idle" })
      yield* sessions.remove(id)
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* sessions.inMemory, { tracked: 0, locks: 0 })
      assert.strictEqual(yield* db.liveStatuses, 0)
    }),
    { hooked: ["pi"] },
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
        `${id} (pi) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${id} to see the request.`,
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
      yield* sessions.check(id) // finishes the turn
      yield* sessions.check(id) // idle → delivers the queue
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "one\n\ntwo")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      const sql = yield* SqlClient.SqlClient
      const [round] = yield* sql<{
        input: string
        inbox: number
      }>`SELECT input, inbox_id AS inbox FROM message WHERE session_id = ${id} AND status = 'working'`
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
        }>`SELECT m.input FROM inbox i JOIN message m ON m.id = i.result_message_id WHERE i.sender_id = ${id} ORDER BY i.id`.pipe(
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
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
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
        yield* sql<{ input: string }>`SELECT input FROM message WHERE session_id = ${id}`.pipe(Effect.orDie),
        [],
      )
      yield* held.release()
      yield* Fiber.join(spawning)
      yield* Fiber.join(typing)
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const [round] = yield* sql<{
        input: string
      }>`SELECT input FROM message WHERE session_id = ${id} AND status = 'working'`
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
      }>`SELECT input FROM message WHERE session_id = ${id} AND status = 'working'`
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
        }>`SELECT input FROM message WHERE session_id = ${id} AND input = 'typed during resume'`,
        [],
      )
      const [round] = yield* until(
        sql<{
          input: string
          inbox: number | null
        }>`SELECT input, inbox_id AS inbox FROM message WHERE session_id = ${id} AND status = 'working'`.pipe(
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
        }>`SELECT input FROM message WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(Effect.orDie),
        [],
      )
      yield* held.release()
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
      assert.deepStrictEqual(
        yield* sql<{
          input: string
        }>`SELECT input FROM message WHERE session_id = ${id} AND input = 'echo of the paste'`.pipe(Effect.orDie),
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
        yield* sql<{ input: string }>`SELECT input FROM message WHERE session_id = ${id} AND input = 'step in'`.pipe(
          Effect.orDie,
        ),
        [],
      )
      yield* held.release()
      yield* Fiber.join(checking)
      yield* Fiber.join(typing)
      assert.deepStrictEqual(
        yield* sql<{
          input: string
          status: string
        }>`SELECT input, status FROM message WHERE session_id = ${id} AND status = 'working'`.pipe(Effect.orDie),
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
      // The lock is held by a check parked inside the runtime; the typed hook fires while it waits.
      const held = yield* herdr.hold("state", name)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      const typing = yield* Effect.forkChild(sessions.userPrompt(id, "typed"))
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      // The typed turn runs and ends, and time moves on, all while the lock is still held.
      yield* herdr.updateAgent(name, (a) => ({ ...a, status: "working", seq: a.seq + 1 }))
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: typed" }, 2000)
      yield* herdr.endTurn(name)
      yield* TestClock.adjust("5 seconds")
      yield* held.release()
      yield* Fiber.join(checking)
      yield* Fiber.join(typing)
      const [round] = yield* sql<{
        startedAt: number
      }>`SELECT started_at AS startedAt FROM message WHERE session_id = ${id} AND input = 'typed'`.pipe(Effect.orDie)
      assert.strictEqual(round!.startedAt, at)
    }),
    { hooked: ["pi"] },
  )

  test(
    "list carries the pane each session was last seen in",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const pane = (yield* herdr.agent(id))!.terminal
      const row = (yield* sessions.list()).find((session) => session.id === id)!
      assert.strictEqual(row.address.id, pane)
      // The terminal is the row's own now (runtime-port.md §2), not an in-memory pane id.
      assert.strictEqual((yield* (yield* Db).getSession(id))!.address.id, pane)
    }),
  )

  test(
    "a result written while confirm gives up is delivered, and the batch stays delivered",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
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
        }>`SELECT delivery_status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
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
        }>`SELECT delivery_status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
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
        }>`SELECT delivery_status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'next'`.pipe(
          Effect.orDie,
        ),
        [{ status: "failed" }],
      )
      assert.include((yield* sqlNotices(id)).at(-1)!, "send: busy")
    }),
    { hooked: ["pi"] },
  )

  test(
    "send to an idle session prompts it at once, in vibestd's own fiber",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
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
        }>`SELECT input, inbox_id AS inbox FROM message WHERE session_id = ${id} AND status = 'working'`.pipe(
          Effect.orDie,
        ),
        (rows) => rows[0]?.input === "fix the tests" && rows[0].inbox !== null,
      )
      const [sent] = yield* sql<{
        id: number
        status: string
      }>`SELECT id, delivery_status AS status FROM inbox WHERE recipient_session_id = ${id} AND content = 'fix the tests'`.pipe(
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
        }>`SELECT id, delivery_status AS status FROM inbox WHERE recipient_session_id = ${receiverId} AND sender_type = 'user' AND id > (SELECT min(id) FROM inbox WHERE recipient_session_id = ${receiverId} AND sender_type = 'user') ORDER BY id`.pipe(
          Effect.orDie,
        )

      // No result file of an earlier turn to stand in for this one's.
      yield* (yield* FileSystem.FileSystem).remove((yield* Layout).resultFile(id))
      // herdr takes the first message's prompt and then refuses it; the second message is accepted meanwhile.
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
      // The refusal's notice is recorded even when the coordinator's pane is already gone and delivery drops it.
      const notices = yield* until(sqlNotices(id), (rows) => rows.some((message) => message.includes("send: failed")))
      assert.match(notices.at(-1)!, new RegExp(`^A message to ${id} was not delivered: .*send: failed`))
      assert.match(notices.at(-1)!, /\n\nfirst$/)
      assert.notMatch(notices.at(-1)!, /second/)
      // Its own delivery is waiting on the same lock and sends once the refusal releases it. It is not failed with the first.
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
      yield* (yield* FileSystem.FileSystem).remove((yield* Layout).resultFile(id))
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
      // Not yet certain it never arrived: the turn stays open, the second waits.
      yield* sessions.check(id)
      assert.deepStrictEqual(pick(yield* db.getSession(id)), { status: "idle", turnState: "open" })
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["second"],
      )
      // The session stayed idle and its state never moved: the turn closes, the owner is told, the second goes out.
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
      const starts = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "next")
      const calls = yield* until(herdr.callsTo("open"), (c) => c.length > starts)
      assert.deepStrictEqual(calls.at(-1)!.argv.slice(0, 2), ["cursor-agent", "--resume=c-123"])
      // A later turn's id does not replace the one the session resumes with.
      yield* writeResult(id, "cursor", { conversation_id: "c-other", text: "status: completed" }, 5000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "c-123")
      // Once herdr reports an id, it replaces the fallback.
      yield* herdr.updateAgent(id, (a) => ({ ...a, session: "h-9" }))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "h-9")
    }),
  )

  test(
    "Cursor: a conversation id that would read as a flag is never kept",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      for (const bad of ["-f", "--yolo", "--force", "a b", ""]) {
        const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "cursor")
        yield* writeResult(id, "cursor", { conversation_id: bad, text: "status: completed" })
        yield* herdr.endTurn(id)
        yield* sessions.check(id)
        assert.isNull((yield* db.getSession(id))!.harnessSessionId, bad)
      }
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
      // Cursor reports its session only through herdr; this one exited before it did.
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
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
    "herdr unreachable before the hand-over: the messages stay queued, no notice, and the next check delivers them",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const prompts = (yield* herdr.callsTo("send")).length
      const notices = db
        .coordinatorPending((yield* db.getSession(id))!.projectId)
        .pipe(Effect.map((rows) => rows.filter((r) => r.kind === "notice")))

      // The connection breaks in the first message's agent.get; a second message arrives meanwhile.
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "first")
      yield* held.reached
      yield* sessions.send(id, "second")
      yield* held.release("unreachable")
      // The second Send's own delivery hands both over, merged.
      yield* until(herdr.callsTo("send"), (calls) => calls.length > prompts)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "first\n\nsecond")
      assert.deepStrictEqual(yield* notices, [])

      // Alone: it waits for the poll.
      yield* writeResult(id, "pi", { text: "status: completed" }, 2000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
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
    }),
    { hooked: ["pi"] },
  )

  test(
    "a session whose turn failed still gets messages the poll delivers",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "model_not_found" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "retry")
      yield* held.reached
      yield* held.release("unreachable")
      yield* TestClock.withLive(Effect.sleep("50 millis"))
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

  // ---- the usage-limit move (architecture.md §8): the same session on another harness ----

  const limited = { window: "5h", percent: 100, status: "limited" as const, resetTime: null }

  test(
    "a forced limit moves the subagent to another harness and its result reaches the parent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* spawnWorking(repo)
      const moved = (yield* db.getSession(id))!
      assert.strictEqual(moved.harnessId, "claude")
      assert.strictEqual(moved.turnState, "open")
      assert.isTrue((yield* herdr.callsTo("open")).at(-1)!.argv.includes("--plugin-dir"))
      assert.include((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
      assert.strictEqual((yield* herdr.callsTo("open"))[0]!.cwd, yield* sessionWorktree(id))
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
      const tasks = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE recipient_session_id = ${id} AND sender_type = 'user'`.pipe(Effect.orDie)
      assert.strictEqual(tasks[0]!.n, 1)

      yield* writeResult(id, "claude", { last_assistant_message: "status: completed\nsummary: moved" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const result = (yield* db.coordinatorPending(moved.projectId)).find((row) => row.kind === "result")
      assert.include(result!.message, "moved")
      assert.notInclude(result!.message, "usage limit")
    }),
  )

  test(
    "a turn-end rate limit moves the subagent to another harness and the task's round carries the result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
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
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND sender_type = 'user' ORDER BY id LIMIT 1) AS task
        FROM message m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      const open = yield* rounds()
      assert.strictEqual(open.length, 1)
      assert.strictEqual(open[0]!.status, "working")
      assert.isNotNull(open[0]!.inbox)
      assert.strictEqual(open[0]!.inbox, open[0]!.task)

      // Older than this round, then a newer file from the harness we left: neither is this round's result.
      yield* writeResult(id, "claude", { last_assistant_message: "status: completed\nsummary: early" }, -60_000)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* writeResult(id, "pi", { error: "rate_limit", text: "status: completed\nsummary: stale" })
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      // A mismatched harness is ignored. The file stays until the new harness replaces it.
      assert.include(yield* fs.readFileString(layout.resultFile(id)), "stale")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.include(yield* fs.readFileString(layout.resultFile(id)), "stale")
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
      }>`SELECT m.inbox_id AS inbox FROM inbox i JOIN message m ON m.id = i.result_message_id WHERE i.sender_id = ${id}`.pipe(
        Effect.orDie,
      )
      assert.strictEqual(linked[0]!.inbox, open[0]!.inbox)
    }),
  )

  test(
    "abort and model_not_found stay failures while the subscription is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const aborted = yield* spawnWorking(repo)
      const missing = yield* spawnWorking(repo)
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
    }),
  )

  test(
    "a quoted rate limit in error_details does not move the session",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "server_error", error_details: "the assistant said rate limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "pi")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "server_error")
    }),
  )

  test(
    "a missing hook stays lost while the subscription is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", turnState: "lost" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
    }),
  )

  test(
    "a failed pane close does not start a second agent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const pane = (yield* herdr.agent(id))!.terminal
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("close")
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
  )

  test(
    "a start failure after a limit tries the next harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("open", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      // The claude start dies on its own (the message names it), not the runtime refusing a place.
      yield* held.release("failed to start claude")
      yield* Fiber.join(checking)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      assert.include((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
    }),
  )

  test(
    "a start failure after a limit is not remembered, so the next limit can use that harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const held = yield* herdr.hold("open", id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* held.reached
      // The claude start dies on its own (the message names it), not the runtime refusing a place.
      yield* held.release("failed to start claude")
      yield* Fiber.join(checking)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      yield* writeResult(id, "cursor", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor", "claude"],
      )
    }),
  )

  const failSeen: Array<{ parent: string | undefined; attempts: ReadonlyArray<[string, string]> }> = []
  test(
    "an unusable harness is never offered; the give-up names only real limits",
    Effect.gen(function* () {
      failSeen.length = 0
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
      // The give-up owned no pane (turn-end no-move): the cursor agent is still running, so the session stays live.
      assert.isNull(row.exitedAt)
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "pi, cursor hit a usage limit")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "cursor"],
      )
    }),
    {
      unusable: ["claude"],
      plugins: [
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
      // The claude start dies on its own (the message names it), not the runtime refusing a place.
      yield* held.release("failed to start claude")
      yield* Fiber.join(checking)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      const rounds = () =>
        sql<{ status: string; inbox: number | null; task: number }>`SELECT m.status AS status, m.inbox_id AS inbox,
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND sender_type = 'user' ORDER BY id LIMIT 1) AS task
        FROM message m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
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
      // The pane and its agent are untouched: still up, still polled.
      assert.isTrue(HashMap.has(yield* herdr.panes, pane))
      assert.strictEqual(harnessOf((yield* herdr.callsTo("open"))[0]!.argv), "pi")
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
      const results = yield* sql<{
        n: number
      }>`SELECT count(*) AS n FROM inbox WHERE sender_id = ${id} AND result_message_id IS NOT NULL`.pipe(Effect.orDie)
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
      assert.include(message, "no harness left")
      assert.include(message, "(claude, cursor, pi limited)")
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
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    {
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
      }>`SELECT count(*) AS n FROM inbox WHERE sender_id = ${id} AND result_message_id IS NOT NULL`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
    {
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
    "pi with no provider moves before start when every pi login is limited",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      yield* subs.report({ harness: "pi", provider: "anthropic", limits: [limited] })
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", provider: null, turnState: "open" })
      assert.isTrue((yield* herdr.callsTo("open")).at(-1)!.argv.includes("--plugin-dir"))
    }),
  )

  test(
    "one limited pi login does not block a free one, and the move uses it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const open = { window: "5h", percent: 0, status: "available" as const, resetTime: null }
      yield* subs.report({ harness: "pi", provider: "anthropic", limits: [limited] })
      yield* subs.report({ harness: "pi", provider: "openai", limits: [open] })
      const repo = yield* makeRepository
      const started = yield* spawnWorking(repo)
      assert.strictEqual((yield* started.db.getSession(started.id))!.harnessId, "pi")
      const { id, sessions, db } = yield* spawnWorking(repo, "claude")
      // A generic limit payload on a claude row: this tests the harness move. Claude's plugin reports no error kind
      // (turn.complete has none), so a real Claude limit is a failed result, not this move.
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const moved = (yield* db.getSession(id))!
      assert.deepInclude(moved, { harnessId: "pi", provider: "openai", turnState: "open" })
      const args = (yield* herdr.callsTo("open")).at(-1)!.argv
      // Pi refuses --provider without --model: the login is recorded on the session, Pi starts on its default.
      assert.notInclude(args, "--provider")
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
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const blocked = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "anthropic" })
      yield* until(db.getSession(blocked.id), (row) => !!row && (row.harnessId !== "pi" || row.startedAt !== null))
      yield* sessions.check(blocked.id)
      assert.strictEqual((yield* db.getSession(blocked.id))!.harnessId, "claude")
      const fine = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai", name: "other" })
      yield* until(db.getSession(fine.id), (row) => !!row && row.startedAt !== null)
      yield* sessions.check(fine.id)
      assert.deepInclude(yield* db.getSession(fine.id), { harnessId: "pi", provider: "openai", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["claude", "pi"],
      )
    }),
  )

  test(
    "an unconfirmed prompt after a limit tries the next harness and leaves the task round working",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sql = yield* SqlClient.SqlClient
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const roundId = (yield* sql<{ id: number }>`SELECT id FROM message WHERE session_id = ${id}`.pipe(
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
        (SELECT id FROM inbox WHERE recipient_session_id = m.session_id AND sender_type = 'user' ORDER BY id LIMIT 1) AS task
        FROM message m WHERE m.session_id = ${id} ORDER BY m.id`.pipe(Effect.orDie)
      assert.deepStrictEqual(
        rounds.map((round) => [round.id, round.status, round.inbox === round.task]),
        [[roundId, "working", true]],
      )
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor"],
      )
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
  )

  test(
    "an unconfirmed prompt after a limit is not remembered, so the next limit can use that harness",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* Ref.set(herdr.skipPromptUpdates, 2)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* untilVirtual(
        Effect.sync(() => checking.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      yield* writeResult(id, "cursor", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "cursor", "claude"],
      )
    }),
  )

  test(
    "a limit on a typed turn resends that text, not the original task",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* fs.remove((yield* Layout).resultFile(id))
      yield* sessions.userPrompt(id, "typed follow-up")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "typed follow-up")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
    }),
  )

  test(
    "a limit on a follow-up resends the newest delivered row, not the first task",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* fs.remove((yield* Layout).resultFile(id))
      yield* sessions.send(id, "add tests")
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)?.text === "add tests")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "add tests")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
    }),
  )

  test(
    "a limit on a merged follow-up resends that batch, not only its last row",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* fs.remove((yield* Layout).resultFile(id))
      const held = yield* herdr.hold("state", id)
      yield* sessions.send(id, "add tests")
      yield* held.reached
      yield* sessions.send(id, "and docs")
      yield* held.release()
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)?.text === "add tests\n\nand docs")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "add tests\n\nand docs")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
    }),
  )

  test(
    "a plugin that forces a limited login at start gets what it asked for: no pre-start move",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "pi")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
    }),
    {
      plugins: [
        Plugin.define({
          id: "rewrite",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                e.harness = "pi"
              }),
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
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const held = yield* herdr.hold("open")
      const spawning = yield* Effect.forkChild(sessions.spawn(yield* spawnInput(repo)))
      yield* held.reached
      // The pi open dies on its own usage limit: not a vibest turn, so the limit move owns the restart.
      yield* held.release("rate_limit")
      yield* Fiber.join(spawning)
      const id = (yield* db.listSessions())[0]!.id
      // The move patches the harness, starts, then opens the turn: wait for the last step, not the first.
      yield* until(db.getSession(id), (w) => !!w && w.harnessId === "claude" && w.turnState === "open")
      // The turn opens at receipt; the re-sent prompt reaches the pane just after.
      yield* until(herdr.callsTo("send"), (calls) => calls.length > 0)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "do it")
      assert.strictEqual((yield* db.sessionBriefs([id])).get(id)?.task, "do it")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude"],
      )
    }),
  )

  test(
    "a move starts on the harness, provider and model agent.fail chose",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository, "claude")
      // A generic limit payload on a claude row: this tests the harness move. Claude's plugin reports no error kind
      // (turn.complete has none), so a real Claude limit is a failed result, not this move.
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* (yield* Sessions).check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "openai", model: "fake-strong" })
      const args = (yield* herdr.callsTo("open")).at(-1)!.argv
      assert.strictEqual(args[args.indexOf("--provider") + 1], "openai")
      assert.strictEqual(args[args.indexOf("--model") + 1], "fake-strong")
    }),
    {
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
    "one limited pi login only rules out that login: the move stays on pi with the free one, and the limit is remembered on the session",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      // The login goes bad only after the session is already running on it.
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
      // A real timestamp, not a placeholder: the clock was advanced past 10 s before the limit.
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
      // Pi refuses --provider without --model: the login is recorded on the session, Pi starts on its default.
      assert.notInclude(args, "--provider")
    }),
  )

  test(
    "a start chain that pins the move back to the login that hit the limit ends instead of looping",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "zai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      // The pinned login is the one that just hit its limit: the round fails there instead of restarting on it.
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "zai", turnState: "failed" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi"],
      )
      assert.include((yield* db.latestInbox(id, "result"))!.message, "no harness left")
    }),
    {
      plugins: [
        Plugin.define({
          id: "zai-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                // Only inside a move (the session has earlier tries); the first start keeps its own harness.
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
    "a remembered limit is forgotten once the login's row was refreshed after it and reads fine",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const subs = yield* Subscriptions
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), provider: "openai" })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      // pi/openai goes bad and the session moves to claude, remembering pi/openai limited.
      yield* subs.report({ harness: "pi", provider: "openai", limits: [limited] })
      yield* TestClock.adjust("10 seconds")
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      // The row is refreshed after the limit and no longer limited: claude's limit moves back to it, not to nothing.
      yield* TestClock.adjust("10 seconds")
      yield* subs.report({
        harness: "pi",
        provider: "openai",
        limits: [{ window: "5h", percent: 5, status: "available", resetTime: null }],
      })
      // A generic limit payload on a claude row: this tests the harness move. Claude's plugin reports no error kind
      // (turn.complete has none), so a real Claude limit is a failed result, not this move.
      yield* writeResult(id, "claude", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", provider: "openai", turnState: "open" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "claude", "pi"],
      )
      const args = (yield* herdr.callsTo("open")).at(-1)!.argv
      // Pi refuses --provider without --model: the login is recorded on the session, Pi starts on its default.
      assert.notInclude(args, "--provider")
    }),
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
        Plugin.define({
          id: "cursor-only",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                // Only inside a move (the session has earlier tries); the first start keeps its own harness.
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
      // The builtin offered claude first; the refusal skipped it and the move landed on cursor, still open.
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "cursor")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        ["pi", "cursor"],
      )
    }),
    {
      plugins: [
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

  test(
    "agent.fail gets the real parent and the attempts, and the subscriptions",
    Effect.gen(function* () {
      failSeen.length = 0
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
      assert.strictEqual(failSeen.length, 1)
      const seen = failSeen[0]!
      assert.strictEqual(seen.parent, main.id)
      assert.deepStrictEqual(seen.attempts, [["pi", "limited"]])
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
    }),
    {
      plugins: [
        Plugin.define({
          id: "see-move",
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
      // A placement refusal (`not_found`, not the `failed` of a start dying inside the terminal) ends the move.
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
      }>`SELECT count(*) AS n FROM inbox WHERE sender_id = ${id} AND result_message_id IS NOT NULL`.pipe(Effect.orDie)
      assert.strictEqual(results[0]!.n, 1)
      assert.deepStrictEqual(yield* sqlNotices(id), [])
    }),
  )

  const lateResult = { on: false, text: "", id: "" }
  test(
    "a late result from the old harness does not delete the new one",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { error: "rate_limit" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.harnessId, "claude")
      lateResult.id = id
      lateResult.text = JSON.stringify({
        harness: "pi",
        ts: 0,
        payload: { error: "rate_limit", text: "status: completed\nsummary: stale" },
      })
      lateResult.on = true
      yield* writeResult(id, "claude", { last_assistant_message: "status: completed\nsummary: kept" })
      yield* sessions.check(id)
      assert.isFalse(lateResult.on)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "claude", turnState: "open" })
      assert.include(yield* fs.readFileString(layout.resultFile(id)), "kept")
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const result = (yield* db.coordinatorPending((yield* db.getSession(id))!.projectId)).find(
        (row) => row.kind === "result",
      )
      assert.include(result!.message, "kept")
      assert.notInclude(result!.message, "stale")
    }),
    {
      readFile: (fs) =>
        new Proxy(fs, {
          get(target, prop) {
            if (prop === "readFileString") {
              return (path: string, encoding?: string) => {
                if (lateResult.on && lateResult.id !== "" && path.endsWith(`/${lateResult.id}.json`)) {
                  lateResult.on = false
                  return Effect.succeed(lateResult.text)
                }
                return target.readFileString(path, encoding)
              }
            }
            const value: unknown = Reflect.get(target, prop, target)
            return typeof value === "function" ? value.bind(target) : value
          },
        }),
    },
  )

  test(
    "a session that exits with messages queued: they fail with a notice instead of waiting forever",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.send(id, "later")
      yield* db.pendingInbox(id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      const notice = (yield* db.coordinatorPending((yield* db.getSession(id))!.projectId)).find(
        (r) => r.kind === "notice" && r.message.startsWith("A message to"),
      )!
      assert.deepStrictEqual(notice.details, {})
      assert.include(notice.message, `${id} exited before it was delivered; send it again to resume the session`)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a delivery cut off by vibestd stopping is not sent again: it fails as possibly delivered",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const prompts = (yield* herdr.callsTo("send")).length
      // As vibestd leaves it when it stops between agent.prompt and recording the delivery.
      const row = yield* db.insertInbox({ sessionId: id, kind: "send", message: "task", details: {} })
      yield* db.setInboxStatus([row.id], "sending")
      yield* sessions.check(id)
      assert.lengthOf(yield* herdr.callsTo("send"), prompts)
      assert.deepStrictEqual(yield* db.inboxWithStatus(id, "failed"), [{ ...row, status: "failed" }])
      // The notice is recorded even when the coordinator's pane is already gone and delivery drops it.
      const notice = yield* db.latestInbox(id, "notice")
      assert.deepStrictEqual(notice!.details, {})
      assert.include(notice!.message, "vibestd stopped while handing it to the session; it may or may not have arrived")
    }),
    { hooked: ["pi"] },
  )

  test(
    "resuming a session writes today's rules and leaves the repository's own files alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const { id, sessions } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const cursorMcp = `${yield* sessionWorktree(id)}/.cursor/mcp.json`
      yield* fs.makeDirectory(`${yield* sessionWorktree(id)}/.cursor`, { recursive: true })
      yield* fs.writeFileString(cursorMcp, JSON.stringify({ mcpServers: { repo: { command: "repo-server" } } }))
      yield* fs.writeFileString(layout.rulesFile(id), "use the send_message tool")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))

      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "next")
      assert.isTrue(yield* fs.exists(cursorMcp))
      const rules = yield* fs.readFileString(layout.rulesFile(id))
      assert.include(rules, "report -- '<message>'")
      assert.notInclude(rules, "send_message")
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
      const sends = (yield* herdr.callsTo("send")).slice(1) // the first is the launch prompt itself
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
        }>`SELECT delivery_status AS status FROM inbox WHERE recipient_session_id = ${id} AND sender_type = 'user' AND id > (SELECT min(id) FROM inbox WHERE recipient_session_id = ${id} AND sender_type = 'user')`.pipe(
          Effect.orDie,
        )).map((r) => r.status),
        ["failed"],
      )
      // The launch prompt, then its Enter and re-paste, then the message's own prompt, Enter and re-paste.
      assert.lengthOf((yield* herdr.callsTo("send")).slice(1), 5)
    }),
    { promptsIgnored: true },
  )

  test(
    "a queued message stays pending while the session is not ready; once herdr has it, it is sending",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      // Not ready: `state` does not answer, so the wait for ready holds the delivery and the message stays pending.
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
      const layout = yield* Layout
      const db = yield* Db
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
      assert.isFalse(yield* fs.exists(layout.rulesFile(id)))
      // Its exit stays visible after the next check.
      yield* (yield* Sessions).check(id)
      const failed = (yield* db.getSession(id))!
      assert.strictEqual(failed.status, "unknown")
      assert.isNotNull(failed.exitedAt)
      // Undone with git, without force. The runtime's `open` failed whole: no terminal to close, never a workspace.
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
      // The runtime's `open` failed whole: no terminal was placed, so none is closed.
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
      // cfg is a tracked file, a directory in the main checkout only: the worktree's cfg cannot hold cfg/x.
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
      // The checks find ENOTDIR before anything is copied, so git removes the clean worktree without force.
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
      // info/exclude is shared, so both are ignored in the main checkout and in the new worktree.
      yield* fs.writeFileString(path.join(repo, ".git", "info", "exclude"), "a.json\nb.json\n", { flag: "a" })
      yield* fs.writeFileString(path.join(repo, ".worktreeinclude"), "a.json\nb.json\n")
      const copied: Array<string> = []
      // The real FileSystem, except copying b.json fails like an I/O error would.
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
      // Undone with git, without force: the worktree held only the ignored a.json copy.
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
    "claude refuses a non-anthropic provider before anything is created",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const error = yield* Effect.flip(
        (yield* Sessions).spawn({ ...(yield* spawnInput(yield* makeRepository, "claude")), provider: "openai" }),
      )
      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.strictEqual(yield* herdr.callCount, 0)
    }),
  )

  test(
    "remove: git removes a clean worktree without force; the pane and its workspace close; the branch stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(id)
      yield* sh(worktree, "switch", "-q", "-c", "feat/x")
      const before = yield* herdr.panes
      const out = (yield* sessions.remove(id))!
      assert.deepStrictEqual(out, {
        id,
        processes: "exited",
        pane: "closed",
        workspace: "none",
        worktree: "removed",
        path: worktree,
        branch: "feat/x",
        reasons: [],
      })
      assert.isFalse(yield* fs.exists(worktree))
      assert.isFalse(yield* fs.exists(layout.rulesFile(id)))
      assert.strictEqual(yield* sh(repo, "branch", "--list", "feat/x"), "feat/x")
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      // Only its own pane and workspace: herdr's other panes are untouched.
      assert.strictEqual(HashMap.size(yield* herdr.panes), HashMap.size(before) - 1)
      // Again: nothing left to do, nothing fails.
      assert.deepInclude(yield* sessions.remove(id), { worktree: "gone", pane: "none", workspace: "none" })
    }),
  )

  test(
    "remove keeps what git would lose (changes, untracked files, commits on no branch, a lock) and tries again when asked",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const repo = yield* makeRepository
      const kept = (out: { readonly worktree: string; readonly reasons: ReadonlyArray<string> }, why: string) => {
        assert.strictEqual(out.worktree, "kept")
        assert.match(out.reasons.join("\n"), new RegExp(why))
      }
      // Changes, then untracked files: kept, the session stopped; once committed, the next rm removes it.
      const a = yield* idleSession(repo)
      const wa = yield* sessionWorktree(a.id)
      yield* fs.writeFileString(`${wa}/README.md`, "changed\n")
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      assert.isNotNull((yield* a.db.getSession(a.id))!.exitedAt)
      assert.isTrue(yield* fs.exists(layout.rulesFile(a.id)))
      yield* sh(wa, "checkout", "--", "README.md")
      yield* fs.writeFileString(`${wa}/new.txt`, "x")
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      yield* sh(wa, "switch", "-q", "-c", "keep/a")
      yield* sh(wa, "add", ".")
      yield* sh(wa, "commit", "-q", "-m", "work")
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", branch: "keep/a" })

      // A commit on no branch: kept. Pushed (on a remote-tracking ref only): saved, so removed.
      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      yield* fs.writeFileString(`${wb}/b.txt`, "b")
      yield* sh(wb, "add", ".")
      yield* sh(wb, "commit", "-q", "-m", "b")
      kept((yield* b.sessions.remove(b.id))!, "commits not on any branch")
      yield* sh(wb, "update-ref", "refs/remotes/origin/b", "HEAD")
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", branch: null })

      // Locked: git itself refuses, and says so.
      const c = yield* idleSession(repo)
      yield* sh(repo, "worktree", "lock", yield* sessionWorktree(c.id))
      kept((yield* c.sessions.remove(c.id))!, "git refused")
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(c.id)))

      // Kept as asked.
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
      // No .worktreeinclude: an ignored file someone made in the worktree goes with it, as git does.
      const a = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(a.id)}/local.env`, "K=1\n")
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", reasons: [] })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(a.id)))

      // With one: the copy, edited in the worktree, goes too; the main checkout's file is untouched.
      yield* fs.writeFileString(`${repo}/.worktreeinclude`, "CLAUDE.md\n")
      const b = yield* idleSession(repo)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`), "local rules\n")
      yield* fs.writeFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`, "edited in the worktree\n")
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", reasons: [] })
      assert.strictEqual(yield* fs.readFileString(`${repo}/CLAUDE.md`), "local rules\n")

      // A file git does not ignore is untracked work: kept, next to the ignored ones.
      const c = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(c.id)}/notes.txt`, "mine\n")
      const out = (yield* c.sessions.remove(c.id))!
      assert.strictEqual(out.worktree, "kept")
      assert.match(out.reasons.join("\n"), /uncommitted changes/)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(c.id)}/notes.txt`), "mine\n")
      assert.isTrue(yield* fs.exists(`${yield* sessionWorktree(c.id)}/CLAUDE.md`))
      // A modified tracked file is work too.
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
      // Held at its first herdr call, before rm marks the session removed: this Send is still accepted.
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

      // The runtime API has no terminal listing: a pane whose shell merely sits there is no proof of use — only a
      // process with its cwd there keeps the worktree (remove.test.ts: "a process still in the worktree").
      const b = yield* idleSession(repo)
      yield* herdr.updateAgent(b.id, (x) => ({ ...x, alive: false }))
      yield* herdr.addPane("user:3", "elsewhere", yield* sessionWorktree(b.id))
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { pane: "closed", worktree: "removed" })
      // Its shell is still there, an empty directory under it: vibest closed only its own terminal.
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
    "remove leaves other panes alone: one beside it in the project workspace stays, and a pane with no process in the worktree no longer keeps it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const paneOf = (id: string) => herdr.agent(id).pipe(Effect.map((found) => found!.terminal))

      const a = yield* idleSession(repo)
      const workspaceA = (yield* paneOf(a.id)).split(":")[0]!
      yield* herdr.addPane("user:1", workspaceA, repo)
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { pane: "closed", workspace: "none", worktree: "removed" })
      assert.isTrue(HashMap.has(yield* herdr.panes, "user:1"))
      assert.isTrue((yield* herdr.workspaceState).find((w) => w.workspaceId === workspaceA)!.open)

      // Only a process with its cwd there keeps the worktree now (the runtime API has no terminal listing).
      const b = yield* idleSession(repo)
      yield* herdr.addPane("user:2", "elsewhere", yield* sessionWorktree(b.id))
      const out = (yield* b.sessions.remove(b.id))!
      assert.deepInclude(out, { pane: "closed", workspace: "none", worktree: "removed" })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(b.id)))
      assert.isTrue(HashMap.has(yield* herdr.panes, "user:2"))
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

      // Its directory now holds some other checkout: not vibest's to delete.
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
    "remove when herdr fails part way: an error, the session not marked stopped, and a retry finishes",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const held = yield* herdr.hold("close")
      const fiber = yield* Effect.forkChild(Effect.flip(sessions.remove(id)))
      yield* held.reached
      yield* held.release("unreachable")
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "RuntimeUnreachable")
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
      assert.deepInclude(yield* sessions.remove(id), { pane: "closed", worktree: "removed" })
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
      // Past the hook grace period: an interrupted turn is not reported as a lost one.
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
      yield* sessions.send(id, "do it differently")
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
    }),
  )

  test(
    "a Claude turn the person stopped with Esc in its pane (turn.complete aborted): one failed result that says it was interrupted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      yield* writeResult(id, "claude", claudeEnd("aborted"))
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      const pending = yield* db.coordinatorPending((yield* db.getSession(id))!.projectId)
      assert.deepStrictEqual(
        pending.map((r) => r.kind),
        ["result"],
      )
      assert.include(pending[0]!.message, "<status>failed</status>")
      assert.include(
        pending[0]!.message,
        "error: interrupted: the turn was stopped in its terminal (Esc) before it ended",
      )
      // Checked again: the same report is not a second result or a new round.
      const before = yield* countRows(id)
      yield* TestClock.adjust("2 minutes")
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* countRows(id), before)
      assert.strictEqual(before.results, 1)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
    }),
  )

  for (const harness of ["claude", "pi"] as const)
    test(
      `vibest interrupt (${harness}): the aborted turn end its Esc makes is no result, no inbox row and no new round`,
      Effect.gen(function* () {
        const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, harness)
        assert.include((yield* sessions.interrupt(id)).message, "interrupted")
        const before = yield* countRows(id)
        // Written after the round closed (the bridge is slower than the pane's settle), and newer than any round.
        yield* writeResult(
          id,
          harness,
          harness === "claude" ? claudeEnd("aborted") : { text: "", error: "aborted", aborted: true },
          60_000,
        )
        yield* TestClock.adjust("2 minutes")
        yield* sessions.check(id)
        const row = (yield* db.getSession(id))!
        assert.strictEqual(row.turnState, "interrupted")
        assert.isUndefined(yield* db.latestInbox(id, "result"))
        assert.deepStrictEqual(yield* db.coordinatorPending(row.projectId), [])
        assert.deepStrictEqual(yield* countRows(id), before)
        assert.strictEqual(before.results, 0)
      }),
      harness === "pi" ? { hooked: ["pi"] } : undefined,
    )

  // Remove and archive (`vibest archive` is Remove; --keep-worktree keeps the worktree) close the round and mark the session
  // archived and exited under its lock: check returns early for it (sessions.ts check), and were it to collect, the
  // aborted payload with no open round is none (rounds.ts collectResult). Either alone holds; with both gone these fail.
  // The file may land while the interrupt key is still going in, or after the archive.
  for (const harness of ["claude", "pi"] as const)
    for (const keepWorktree of [false, true])
      test(
        `${keepWorktree ? "archive --keep-worktree" : "remove"} of a working ${harness} session: the aborted turn end of its interrupt is no result, written during the interrupt or after`,
        Effect.gen(function* () {
          const herdr = yield* FakeRuntime
          const repo = yield* makeRepository
          const aborted = harness === "claude" ? claudeEnd("aborted") : { text: "", error: "aborted", aborted: true }
          // During: the file lands while the interrupt key is held, before the session is marked archived.
          const during = yield* spawnWorking(repo, harness)
          const held = yield* herdr.hold("send", during.id)
          const removing = yield* Effect.forkChild(during.sessions.remove(during.id, { keepWorktree }))
          yield* held.reached
          yield* writeResult(during.id, harness, aborted, 60_000)
          yield* held.release()
          yield* Fiber.join(removing)
          // After: the file lands once the session is archived.
          const after = yield* spawnWorking(repo, harness)
          yield* after.sessions.remove(after.id, { keepWorktree })
          yield* writeResult(after.id, harness, aborted, 60_000)
          yield* TestClock.adjust("2 minutes")
          for (const { id, sessions, db } of [during, after]) {
            const row = (yield* db.getSession(id))!
            assert.isTrue(row.metadata.archived, id)
            yield* sessions.check(id)
            assert.deepStrictEqual(yield* countRows(id), { rounds: 1, results: 0 }, id)
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
    "interrupt that does not take: SessionBusy, the turn stays open",
    Effect.gen(function* () {
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      // The settle polls the agent's state on the test clock: move virtual time past STOP_WAIT (10 s), giving the
      // forked interrupt real time between steps so a loaded machine cannot starve it.
      for (let i = 0; i < 60 && interrupting.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust("250 millis")
        yield* TestClock.withLive(Effect.sleep("2 millis"))
      }
      const error = yield* Effect.flip(Fiber.join(interrupting))
      assert.strictEqual(error._tag, "SessionBusy")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
    }),
    { interruptIgnored: true },
  )

  test(
    "interrupt that does not take: the round stays open, so the late aborted turn.complete is delivered as an interrupted result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      for (let i = 0; i < 60 && interrupting.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust("250 millis")
        yield* TestClock.withLive(Effect.sleep("2 millis"))
      }
      assert.strictEqual((yield* Effect.flip(Fiber.join(interrupting)))._tag, "SessionBusy")
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
    "a reset event keeps the session where it was: its terminal id is the runtime's own, a move is its business",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const before = (yield* db.getSession(id))!.address
      yield* PubSub.publish(herdr.events, { type: "reset", machine: "local" })
      yield* Effect.yieldNow
      assert.deepStrictEqual((yield* db.getSession(id))!.address, before)
    }),
  )

  test(
    "run --peer shares the worktree; a borrower never removes it, and archiving the owner keeps it while a borrower is live",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
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
      assert.deepInclude(got.metadata, { peer: peer.id })
      assert.isUndefined((yield* peer.db.getSession(id))!.metadata.worktreeName)
      const ownerRow = (yield* peer.db.getSession(peer.id))!
      assert.match(ownerRow.metadata.worktreeName!, /^[0-9a-f]{4}$/)
      assert.notStrictEqual(ownerRow.metadata.worktreeName, peer.id)
      assert.strictEqual(
        worktree,
        layout.allocationWorktree(ownerRow.metadata.worktreeRepository!, ownerRow.metadata.worktreeName!),
      )
      const rules = yield* fs.readFileString(layout.rulesFile(id))
      assert.include(rules, "others may be making changes in this worktree too")
      assert.notInclude(rules, peer.id)
      assert.notInclude(rules, "git switch -c <branch>")

      // A peer's peer shares the same worktree, split from the pane of the session it named.
      const third = yield* peer.sessions.spawn({ ...(yield* spawnInput(repo)), peer: id })
      assert.strictEqual((yield* peer.db.getSession(third.id))!.metadata.peer, peer.id)
      assert.isUndefined((yield* peer.db.getSession(third.id))!.metadata.worktreeName)
      assert.isUndefined((yield* peer.db.getSession(third.id))!.metadata.worktreeRepository)
      yield* until(peer.db.getSession(third.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      assert.strictEqual((yield* peer.sessions.get(third.id)).worktree, worktree)
      assert.strictEqual((yield* herdr.callsTo("open"))[2]!.near, pane)
      assert.lengthOf(yield* herdr.callsTo("open"), 3)

      // The owner is still live. Archiving it must not delete the directory a borrower is using.
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
      assert.include(borrower.reasons.join("\n"), `it is ${peer.id}'s (vibest run --peer)`)
      assert.isFalse(yield* fs.exists(layout.rulesFile(id)))
      assert.isFalse(yield* fs.exists(layout.resultFile(id)))
      assert.isTrue(yield* fs.exists(worktree))

      // The other borrower is still live, so a second archive of the owner still keeps the directory.
      const ownerSecond = (yield* peer.sessions.remove(peer.id))!
      assert.deepInclude(ownerSecond, { worktree: "kept", path: worktree })
      assert.include(ownerSecond.reasons.join("\n"), third.id)
      assert.notInclude(ownerSecond.reasons.join("\n"), `session ${id} still shares`)
      assert.isTrue(yield* fs.exists(worktree))

      yield* writeResult(third.id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(third.id)
      yield* peer.sessions.check(third.id)
      const lastBorrower = (yield* peer.sessions.remove(third.id))!
      assert.deepInclude(lastBorrower, { worktree: "kept", path: worktree })
      // The last borrower of an archived owner frees the directory: nobody else would.
      assert.include(lastBorrower.reasons.join("\n"), `${peer.id}'s shared worktree removed`)
      assert.isFalse(yield* fs.exists(worktree))
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
      const unknown = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: "ffffffff" }))
      assert.strictEqual(unknown._tag, "NoSuchSession")
      assert.include(unknown.message, "--peer ffffffff: no session ffffffff")

      const { id, row } = yield* spawnWorking(repo)
      const created = () => herdr.callsTo("open").pipe(Effect.map((calls) => calls.length))
      const before = yield* created()
      const otherRepo = yield* makeRepository
      const cross = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(otherRepo)), peer: id }))
      assert.include(cross.message, "belongs to another project")
      // The owner moved to another machine: its worktree is not this start's runtime place any more.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE session SET runtime = json_set(runtime, '$.machine', 'other') WHERE id = ${id}`
      const otherSession = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(otherSession.message, "ineligible")
      yield* sql`UPDATE session SET runtime = json_set(runtime, '$.machine', 'local') WHERE id = ${id}`
      yield* db.updateSession(id, { metadata: { ...row.metadata, archived: true, removed: true } })
      const archived = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(archived.message, "it was archived")
      yield* db.updateSession(id, { metadata: row.metadata })
      yield* fs.remove(yield* sessionWorktree(id), { recursive: true })
      const gone = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(gone.message, "ineligible")
      assert.include(gone.message, "gone")
      assert.strictEqual(yield* created(), before)
      assert.isUndefined(yield* db.getSession("ffffffff"))
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

  const peerRows = (ownerId: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      return (yield* db.listSessions({ stopped: true })).filter((s) => s.metadata.peer === ownerId)
    })

  /** Park admission after the peer check and before insert. Caller resets `peerAdmitPause`. */
  const parkAdmit = Effect.gen(function* () {
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
      const parked = yield* parkAdmit
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
          yield* until(peerRows(owner.id), (rows) => rows.length === 1)
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
        assert.deepStrictEqual(yield* peerRows(owner.id), [])
        assert.isUndefined(archiving.pollUnsafe())
        yield* parked.release
        yield* until(peerRows(owner.id), (rows) => rows.length === 1)
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), (yield* peerRows(owner.id))[0]!.id)
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
        owner.db.getSession((yield* peerRows(owner.id))[0]!.id),
        (w) => !!w && (w.startedAt !== null || w.exitedAt !== null),
      )
    }),
  )

  test(
    "run --peer of a borrower takes the owner's lock, so owner archive cannot delete the shared tree",
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
      const parked = yield* parkAdmit
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
          yield* until(peerRows(owner.id), (rows) => rows.some((s) => s.id !== mid.id && s.exitedAt === null))
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          assert.fail(
            "owner archive listed before peer-of-peer insert and removed the tree: worktree=" + archived.worktree,
          )
        }
        yield* parked.release
        yield* until(peerRows(owner.id), (rows) => rows.some((s) => s.id !== mid.id))
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
      // The runtime's `open` failed whole: no terminal was placed, so none is closed; the owner's own stays.
      assert.deepStrictEqual(newCloses, [])
      assert.isTrue(HashMap.has(yield* herdr.panes, ownerPane))
      assert.isTrue(yield* fs.exists(worktree))
      // One open attempt: this launch's own, which the runtime refused.
      assert.strictEqual((yield* herdr.callsTo("open")).length, created + 1)
      assert.strictEqual((yield* owner.db.getSession(id))!.metadata.peer, owner.id)
    }),
  )
})

/** Set by a test: the next read of a session's newest result stops right after it, until `release`. */
let resultRead: { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> } | undefined
/**
 * Set by a test: completed by the next read of that session's row, the first thing a delivered result's archive does. It
 * says that archive has started, not how far it got: the outcome must not depend on where it is.
 */
let sessionRead: { readonly id: string; readonly done: Deferred.Deferred<void> } | undefined
const gated: TestOptions = {
  db: (db) => ({
    ...db,
    latestInbox: (id, kind) =>
      db.latestInbox(id, kind).pipe(
        Effect.tap(() => {
          const gate = kind === "result" ? resultRead : undefined
          if (!gate) return Effect.void
          resultRead = undefined
          return Deferred.succeed(gate.reached, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
        }),
      ),
    getSession: (id) =>
      db.getSession(id).pipe(
        Effect.tap(() => {
          const gate = sessionRead?.id === id ? sessionRead : undefined
          if (!gate) return Effect.void
          sessionRead = undefined
          return Deferred.succeed(gate.done, undefined)
        }),
      ),
  }),
}

describe.concurrent("vibest run --archive-on-completion", () => {
  /** A working `--archive-on-completion` session, and the coordinator as herdr runs it: `claude` takes rows with agent.prompt, `pi` pulls them. */
  const archiveSession = (
    repo: string,
    coordinator: "claude" | "pi" = "claude",
    input: { readonly peer?: string } = {},
  ) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), coordinator, false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* herdr.seedAgent("test/coord")
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), ...input, archive: true })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      return { id, sessions, db, herdr, projectId: (yield* db.getSession(id))!.projectId }
    })

  /** The turn ends with this report and vibestd collects it. */
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

  const archived = (db: Db["Service"], id: string) => db.getSession(id).pipe(Effect.map((w) => !!w?.metadata.archived))
  /** Real time for a forked archive to run, if one was started. */
  const settle = TestClock.withLive(Effect.sleep("100 millis"))
  const latestNotice = (id: string) => sqlNotices(id).pipe(Effect.map((n) => n.at(-1) ?? ""))

  test(
    "a completed result typed into the coordinator archives the session; a clean archive sends no notice (nothing to do); vibest result still works",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const w = yield* archiveSession(yield* makeRepository)
      assert.isTrue((yield* w.db.getSession(w.id))!.metadata.archive)
      yield* finishTurn(w, "status: completed\nsummary: found it")
      yield* until(archived(w.db, w.id), (a) => a)
      yield* until(fs.exists(yield* sessionWorktree(w.id)), (e) => !e)
      yield* until(w.db.getSession(w.id), (r) => r!.exitedAt !== null)
      yield* settle
      const rows = yield* sql<{
        kind: string
        status: string
      }>`SELECT CASE WHEN m.result_message_id IS NOT NULL THEN 'result' WHEN m.sender_type = 'system' THEN 'notice' WHEN m.sender_type = 'session' THEN 'report' ELSE 'send' END AS kind, m.delivery_status AS status FROM inbox m WHERE m.sender_id = ${w.id} ORDER BY m.id`.pipe(
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
      yield* settle
      yield* Fiber.interrupt(pulling)
      assert.lengthOf(batches, 1)
      assert.include(batches[0]!, "<agent-result")
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
  )

  test(
    "a Claude coordinator on the inbox bridge: archived once it acked the claim holding the result",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const coord = yield* db.coordinatorLaunch(yield* repositoryKey(repo), "claude", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", "claude-1")
      yield* herdr.seedAgent("test/coord")
      const projectId = yield* db.projectId(yield* repositoryKey(repo))
      const call = { projectId, terminal: "test/coord", claudeSessionId: "claude-1" }
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      const sessions = yield* Sessions
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), archive: true })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      yield* finishTurn({ id, sessions, herdr }, "status: completed")
      const claim = yield* until(inbox.pull({ ...call, generation }), (r) => r.token !== undefined)
      yield* settle
      assert.isFalse(yield* archived(db, id))
      assert.deepStrictEqual(yield* inbox.ack({ ...call, generation, token: claim.token! }), { acked: true })
      yield* until(archived(db, id), (a) => a)
    }),
  )

  slowTest(
    "not archived while the result is only queued, when its delivery fails or is dropped, or when the Pi extension never acked it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      // Queued: the coordinator is busy.
      const a = yield* archiveSession(repo)
      yield* a.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "working" }))
      yield* finishTurn(a, "status: completed")
      yield* settle
      assert.strictEqual((yield* a.db.latestInbox(a.id, "result"))!.status, "pending")
      assert.isFalse(yield* archived(a.db, a.id))
      // agent.prompt fails: the row is failed, never delivered.
      yield* a.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "idle" }))
      const held = yield* a.herdr.hold("send", "test/coord")
      const inbox = yield* Inbox
      const delivering = yield* Effect.forkChild(inbox.deliver(a.projectId))
      yield* held.reached
      yield* held.release("failed")
      yield* Fiber.join(delivering)
      yield* settle
      assert.strictEqual((yield* a.db.latestInbox(a.id, "result"))!.status, "failed")
      assert.isFalse(yield* archived(a.db, a.id))
      // Dropped: the coordinator's pane is gone.
      const b = yield* archiveSession(repo)
      yield* b.herdr.updateAgent("test/coord", (c) => ({ ...c, alive: false }))
      yield* finishTurn(b, "status: completed")
      yield* until(b.db.latestInbox(b.id, "result"), (r) => r?.status === "dropped")
      yield* settle
      assert.isFalse(yield* archived(b.db, b.id))
      // A Pi stream that took the batch and ended before its next pull: failed, not delivered.
      const c = yield* archiveSession(repo, "pi")
      yield* finishTurn(c, "status: completed")
      yield* inbox.stream(c.projectId).pipe(Stream.take(1), Stream.runDrain)
      yield* settle
      assert.strictEqual((yield* c.db.latestInbox(c.id, "result"))!.status, "failed")
      assert.isFalse(yield* archived(c.db, c.id))
    }),
  )

  slowTest(
    "never after a failed turn",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const a = yield* archiveSession(repo)
      // The model writing "failed" changes nothing; the harness reporting an error does.
      yield* finishTurn(a, "status: failed\nsummary: tests fail", "model_error")
      yield* until(a.db.latestInbox(a.id, "result"), (r) => r?.status === "delivered")
      // A failed turn's summary is the error, not the reply's first line, so vibest ls says why.
      const row = yield* a.db.latestInbox(a.id, "result")
      assert.match(String(row!.details.summary), /^Agent ".*" failed: model_error$/)
      assert.include(row!.message, "<result>\nstatus: failed\nsummary: tests fail")
      yield* settle
      assert.isFalse(yield* archived(a.db, a.id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "never after a failed turn; the flag stays, so the next completed result archives it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const b = yield* archiveSession(repo)
      yield* finishTurn(b, "which one?", "model_error")
      yield* until(b.db.latestInbox(b.id, "result"), (r) => r?.status === "delivered")
      yield* settle
      assert.isFalse(yield* archived(b.db, b.id))
      yield* b.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "idle" }))
      yield* b.sessions.send(b.id, "the first one")
      yield* until(b.db.getSession(b.id), (w) => w?.turnState === "open")
      yield* finishTurn(b, "status: completed")
      yield* until(archived(b.db, b.id), (x) => x)
    }),
    { hooked: ["pi"] },
  )

  test(
    "never after a lost turn: the turn ended and no hook fired within the grace period",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = yield* archiveSession(repo)
      yield* c.herdr.endTurn(c.id)
      yield* c.sessions.check(c.id)
      yield* TestClock.adjust("11 seconds")
      yield* c.sessions.check(c.id)
      assert.strictEqual((yield* c.db.getSession(c.id))!.turnState, "lost")
      yield* until(c.db.latestInbox(c.id, "result"), (r) => r?.status === "delivered")
      yield* settle
      assert.isFalse(yield* archived(c.db, c.id))
    }),
    { hooked: ["pi"] },
  )

  test(
    "never after an interrupted turn: it has no result",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      assert.include((yield* w.sessions.interrupt(w.id)).message, "interrupted")
      yield* TestClock.adjust("11 seconds")
      yield* w.sessions.check(w.id)
      yield* settle
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.isFalse(yield* archived(w.db, w.id))
    }),
  )

  test(
    "a message queued when the result is delivered: not archived, no notice (nothing to do), and the message is delivered",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* w.sessions.send(w.id, "one more thing")
      yield* finishTurn(w, "status: completed")
      yield* settle
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
      // Held at the archive path's first state read, before it marks the session removed: this Send is still accepted.
      const held = yield* w.herdr.hold("state", w.id)
      const finishing = yield* Effect.forkChild(finishTurn(w, "status: completed"))
      yield* held.reached
      yield* w.sessions.send(w.id, "one more thing")
      yield* held.release()
      yield* Fiber.join(finishing)
      yield* settle
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.isFalse(yield* archived(w.db, w.id))
      assert.lengthOf(yield* w.db.inboxWithStatus(w.id, "failed"), 0)
      // Send's own delivery, waiting for the lock, hands it over: no check needed.
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "the session turns busy after it went idle (the user typed in its pane): refused before the tombstone, still unarchived and usable",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      const wait = yield* w.herdr.hold("state", w.id)
      const finishing = yield* Effect.forkChild(finishTurn(w, "status: completed"))
      yield* wait.reached
      // The next-but-two state read is removeLocked's own busy check (the archive's look and the settle's one idle poll come first).
      const get = yield* w.herdr.hold("state", w.id, 2)
      yield* wait.release()
      yield* get.reached
      yield* w.herdr.updateAgent(w.id, (a) => ({ ...a, status: "working" }))
      yield* get.release()
      yield* Fiber.join(finishing)
      // Never interrupted: unlike vibest archive, the automatic one leaves current work alone, and says nothing.
      yield* settle
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      // Never interrupted: no keys were sent to it (the texts recorded are its own prompt and the coordinator's batch).
      assert.deepStrictEqual(
        (yield* w.herdr.callsTo("send")).filter((call) => call.keys !== undefined),
        [],
      )
      const row = (yield* w.db.getSession(w.id))!
      assert.isUndefined(row.metadata.archived)
      assert.isUndefined(row.metadata.removed)
      assert.lengthOf(yield* w.herdr.callsTo("close"), 0)
      // Still usable: its turn ends, and a message is accepted and delivered by Send itself.
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.send(w.id, "next")
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "a reply with no status line ends normally, so it is archived: the status is what vibest observed",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* finishTurn(w, "status: needs_input\nDONE-1234")
      yield* until(archived(w.db, w.id), (x) => x)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.include(row!.message, "<status>completed</status>")
    }),
  )

  test(
    "a message sent once it decided to archive is refused, never accepted and then failed",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const w = yield* archiveSession(yield* makeRepository)
      const held = yield* fake.holdCwd()
      yield* finishTurn(w, "status: completed")
      yield* held.reached
      assert.strictEqual(
        (yield* Effect.flip(w.sessions.send(w.id, "too late"))).message,
        `${w.id} was archived; run a new session`,
      )
      yield* held.release()
      yield* until(w.db.getSession(w.id), (r) => r!.exitedAt !== null)
      yield* settle
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
      yield* until(latestNotice(w.id), (m) => m.includes("not archived"))
      assert.include(yield* latestNotice(w.id), "its harness already exited")
      assert.isFalse(yield* archived(w.db, w.id))
    }),
  )

  test(
    "vibest archive while the automatic one runs: SessionBusy, and the automatic one finishes",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const w = yield* archiveSession(yield* makeRepository)
      const held = yield* fake.holdCwd()
      yield* finishTurn(w, "status: completed")
      yield* held.reached
      const busy = yield* Effect.flip(w.sessions.remove(w.id))
      assert.strictEqual(busy._tag, "SessionBusy")
      assert.include(busy.message, "already being removed")
      yield* held.release()
      const fs = yield* FileSystem.FileSystem
      yield* until(fs.exists(yield* sessionWorktree(w.id)), (e) => !e)
    }),
  )

  /**
   * A first completed result delivered while a check holds the session's lock, so its archive waits for the lock; then a
   * newer result with `details`, written and not yet delivered. `release` lets the check, and so that archive, go on.
   */
  const firstWaiting = (w: Effect.Success<ReturnType<typeof archiveSession>>, details: Record<string, unknown>) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      yield* w.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "working" }))
      yield* finishTurn(w, "status: completed\nsummary: first")
      const check = yield* w.herdr.hold("state", w.id)
      const checking = yield* Effect.forkChild(w.sessions.check(w.id))
      yield* check.reached
      yield* w.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "idle" }))
      const looked = yield* archiveLooks(w.id)
      yield* inbox.deliver(w.projectId)
      assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
      // Its archive has started; the check holds the lock, so it gets no further until `release`.
      yield* looked
      yield* w.db.finishTurn(
        w.id,
        { turnState: "completed", status: "idle" },
        { sessionId: w.id, kind: "result", message: "second", details },
      )
      yield* w.herdr.updateAgent("test/coord", (c) => ({ ...c, status: "idle" }))
      return { release: check.release().pipe(Effect.andThen(Fiber.join(checking))) }
    })

  /** Arms `sessionRead` before a delivery: the effect it returns waits until that result's archive has started. */
  const archiveLooks = (id: string) =>
    Deferred.make<void>().pipe(
      Effect.map((done) => {
        sessionRead = { id, done }
        return Deferred.await(done)
      }),
    )

  /** Both archives are done once a check gets the session's lock after them. Then nothing interrupted it. */
  const bothDone = (w: Effect.Success<ReturnType<typeof archiveSession>>) =>
    Effect.gen(function* () {
      const sends = (yield* w.herdr.callsTo("send")).length
      yield* w.sessions.check(w.id)
      // Nothing new was typed: the check after both archives sends nothing (the launch prompt's own send is counted before it).
      assert.lengthOf(yield* w.herdr.callsTo("send"), sends)
    })

  test(
    "a newer completed result delivered while the first one's archive waits for the lock: archived once, no notice",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const w = yield* archiveSession(yield* makeRepository)
      const first = yield* firstWaiting(w, { status: "completed", summary: "second" })
      const looked = yield* archiveLooks(w.id)
      yield* inbox.deliver(w.projectId)
      assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
      // The newer result's archive has started while the first one still waits.
      yield* looked
      yield* first.release
      // The first decision is the waiting archive's: it archives on the newer result instead of skipping.
      yield* until(archived(w.db, w.id), (a) => a)
      yield* bothDone(w)
      assert.lengthOf(yield* w.herdr.callsTo("close"), 1)
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
    gated,
    true,
  )

  test(
    "a newer result still being sent when the waiting archive reads it: archived once it is delivered; never when its delivery fails",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const repo = yield* makeRepository
      for (const failure of [undefined, "server_error"]) {
        const w = yield* archiveSession(repo)
        const first = yield* firstWaiting(w, { status: "completed", summary: "second" })
        const prompt = yield* w.herdr.hold("send", "test/coord")
        const sending = yield* Effect.forkChild(inbox.deliver(w.projectId))
        yield* prompt.reached
        const read = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        resultRead = read
        yield* first.release
        // The first archive has read the newer result while it is `sending`; it is delivered (or fails) before that archive goes on.
        yield* Deferred.await(read.reached)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "sending")
        const looked = yield* archiveLooks(w.id)
        yield* prompt.release(failure)
        yield* Fiber.join(sending)
        if (failure === undefined) {
          assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
          yield* looked
        }
        yield* Deferred.succeed(read.release, undefined)
        if (failure === undefined) {
          yield* until(archived(w.db, w.id), (a) => a)
          yield* bothDone(w)
          assert.deepStrictEqual(yield* sqlNotices(w.id), [])
          continue
        }
        sessionRead = undefined
        yield* bothDone(w)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "failed")
        assert.isFalse(yield* archived(w.db, w.id))
      }
    }),
    gated,
    true,
  )

  test(
    "the newer delivered result is failed, a message waits, or a new turn began: the waiting archive does not archive on it",
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const repo = yield* makeRepository
      for (const newer of ["failed", "message", "turn"]) {
        const w = yield* archiveSession(repo)
        const completed = newer === "message" || newer === "turn"
        const first = yield* firstWaiting(w, { status: completed ? "completed" : newer })
        if (newer === "message") assert.isDefined(yield* w.db.insertSend(w.id, "one more thing"))
        if (newer === "turn") yield* w.db.updateSession(w.id, { turnState: "open" })
        // A result that is not completed never starts an archive of its own, so there is nothing of it to wait for.
        const looked = completed ? yield* archiveLooks(w.id) : Effect.void
        yield* inbox.deliver(w.projectId)
        assert.strictEqual((yield* w.db.latestInbox(w.id, "result"))!.status, "delivered")
        yield* looked
        yield* first.release
        yield* bothDone(w)
        assert.isFalse(yield* archived(w.db, w.id), newer)
        assert.isUndefined((yield* w.db.getSession(w.id))!.metadata.removed, newer)
        // The message was accepted first: never failed, and the check after the archives delivered it.
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
    "run --peer: a borrower keeps the shared worktree; one whose owner is already archived names the owner to archive",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const a = yield* archiveSession(repo, "claude", { peer: owner.id })
      yield* finishTurn(a, "status: completed")
      const first = yield* until(latestNotice(a.id), (m) => m.includes("archived ("))
      assert.include(first, `worktree kept at ${yield* sessionWorktree(owner.id)}`)
      assert.include(first, `it is ${owner.id}'s (vibest run --peer)`)
      assert.notInclude(first, "is archived too")

      // The owner archived while the next borrower is live: the directory stays for it.
      const b = yield* archiveSession(repo, "claude", { peer: owner.id })
      assert.include((yield* owner.sessions.remove(owner.id))!.reasons.join("\n"), `session ${b.id} still shares it`)
      yield* finishTurn(b, "status: completed")
      const second = yield* until(latestNotice(b.id), (m) => m.includes("archived ("))
      assert.include(
        second,
        `${owner.id} is archived too: run vibest archive ${owner.id} to remove the shared worktree.`,
      )
      assert.deepInclude((yield* owner.sessions.remove(owner.id))!, { worktree: "removed" })
    }),
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
      const notice = yield* until(latestNotice(owner.id), (m) => m.includes("archived ("))
      assert.include(notice, `session ${id} still shares it (vibest run --peer)`)
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(owner.id)))
    }),
  )

  test(
    "run --peer: an owner archived with --keep-worktree keeps it after its last borrower is archived",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const b = yield* archiveSession(repo, "claude", { peer: owner.id })
      yield* owner.sessions.remove(owner.id, { keepWorktree: true })
      const worktree = yield* sessionWorktree(owner.id)
      const out = (yield* b.sessions.remove(b.id))!
      assert.notInclude(out.reasons.join("\n"), "shared worktree")
      assert.isTrue(yield* fs.exists(worktree))
    }),
  )

  test(
    "without --archive-on-completion a delivered completed result archives nothing",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      // A coordinator that takes its rows by terminal text, so the result is delivered without a bridge.
      const db = yield* Db
      const sessions = yield* Sessions
      yield* db.coordinatorLaunch(yield* repositoryKey(repo), "claude", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* herdr.seedAgent("test/coord")
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (row) => !!row && (row.startedAt !== null || row.exitedAt !== null))
      yield* sessions.check(id)
      const w = { id, row: (yield* db.getSession(id))!, sessions, db }
      assert.isUndefined(w.row.metadata.archive)
      yield* finishTurn({ ...w, herdr }, "status: completed")
      yield* until(w.db.latestInbox(w.id, "result"), (r) => r?.status === "delivered")
      yield* settle
      assert.isFalse(yield* archived(w.db, w.id))
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
  )
})
