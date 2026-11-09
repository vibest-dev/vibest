import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { AgentRefused } from "@vibest/core/plugins"
import { Sessions } from "@vibest/core/sessions"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { ID } from "@vibest/schema/id"
import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Path } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import {
  FakeGit,
  FakeRuntime,
  FakeProcesses,
  makeRepository,
  settled,
  TURNS,
  until,
  untilVirtual,
  writeResult,
  systemPromptFile,
  projectOf,
} from "./fakes.ts"
import { spawnInput, spawnWorking, sessionWorktree, test, pick, sqlNotices } from "./sessions-helpers.ts"

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
      assert.deepStrictEqual(yield* (yield* FakeGit).git.linkedWorktrees(repo), [wt])
      assert.strictEqual(yield* fs.readFileString(path.join(wt, "README.md")), "hi\n")
      assert.isFalse(yield* fs.exists(path.join(wt, "CLAUDE.md")))
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
    "a harness whose reported pid has died is exited even when the runtime still says the terminal is running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const pid = (yield* db.getSession(id))!.metadata.pid
      assert.isTrue(typeof pid === "number" && pid > 0)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "unknown", alive: true }))
      yield* processes.set(pid!, "exited")
      yield* sessions.check(id)
      yield* settled
      const row = (yield* db.getSession(id))!
      assert.isNotNull(row.exitedAt)
      assert.strictEqual(row.turnState, "failed")
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
})
