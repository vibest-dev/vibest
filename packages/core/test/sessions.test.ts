import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { ID } from "@vibest/schema/id"
import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Path } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { replyOf, sentBy, settled, EXECUTIONS, until, untilVirtual, writeEnd, systemPromptFile } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, spawnWorking, sessionWorktree, test, pick, sqlNotices } from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  const withMain = (repo: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      return yield* db.coordinatorLaunch(
        yield* projectOf(repo),
        "pi",
        false,
        { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } },
        { provider: "openai", model: "fake-strong" },
      )
    })
  const chosen = (id: string) =>
    Effect.gen(function* () {
      const row = yield* (yield* Db).getSession(id)
      return [row!.harnessId, row!.provider, row!.model]
    })

  test(
    "spawn without a harness from the main agent inherits its harness, provider and model",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const main = yield* withMain(repo)
      const input = { ...(yield* spawnInput(repo)), harness: undefined, parentSessionId: main.sessionId }
      const { id } = yield* (yield* Sessions).spawn(input)
      assert.deepStrictEqual(yield* chosen(id), ["pi", "openai", "fake-strong"])
    }),
  )

  test(
    "spawn without a harness from a plain terminal inherits the project's main agent; an explicit harness drops its provider and model; a model alone keeps the rest",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* withMain(repo)
      const sessions = yield* Sessions
      const base = { ...(yield* spawnInput(repo)), harness: undefined }
      const inherited = yield* sessions.spawn(base)
      assert.deepStrictEqual(yield* chosen(inherited.id), ["pi", "openai", "fake-strong"])
      const explicit = yield* sessions.spawn({ ...base, harness: "claude", name: "explicit" })
      assert.deepStrictEqual(yield* chosen(explicit.id), ["claude", null, null])
      const model = yield* sessions.spawn({ ...base, model: "fake-model", name: "model" })
      assert.deepStrictEqual(yield* chosen(model.id), ["pi", "openai", "fake-model"])
    }),
  )

  test(
    "spawn without a harness and nothing to inherit is NoHarnessChosen",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const error = yield* Effect.flip((yield* Sessions).spawn({ ...(yield* spawnInput(repo)), harness: undefined }))
      assert.strictEqual(error._tag, "NoHarnessChosen")
      assert.include(error.message, "no harness to inherit")
    }),
  )

  test(
    "a definition updated by a plugin changes the next spawn's argv",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const herdr = yield* FakeRuntime
      yield* (yield* Harnesses).transform((editor) =>
        editor.update("pi", (definition) => {
          const before = definition.launchArgs
          definition.launchArgs = (input) => [...before(input), "--from-plugin"]
        }),
      )
      yield* spawnWorking(repo)
      assert.strictEqual((yield* herdr.callsTo("open"))[0]!.argv.at(-1), "--from-plugin")
    }),
  )

  test(
    "a session whose harness no plugin provides still lists, and a restart says no plugin provides it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { id } = yield* spawnWorking(repo)
      yield* (yield* Harnesses).transform((editor) => editor.remove("pi"))
      const sessions = yield* Sessions
      assert.strictEqual((yield* sessions.list()).find((row) => row.id === id)?.harnessId, "pi")
      const [restarted] = yield* sessions.restart([id])
      assert.isFalse(restarted!.ok)
      assert.include(restarted!.message, "no loaded plugin provides its harness")
    }),
  )

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
      assert.strictEqual(row.executionState, "open")

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
    "an execution end reported while vibestd drains (update, daemon restart) is still written: its check is a settlement",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      const drain = yield* Drain
      assert.isTrue(yield* drain.begin)
      yield* writeEnd(id, "pi", { text: "done while draining" })
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.executionState !== "open")
      assert.strictEqual(w.executionState, "completed")
      assert.include(yield* replyOf(id), "done while draining")
      yield* drain.reopen
    }),
  )

  test(
    "hook result + ExecutionEnd ends the execution, keeps the reply as the execution's reply and sends nothing",
    Effect.gen(function* () {
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "\nDone it.\nstatus: failed\n\n## Remember\nuse bun" })
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.executionState !== "open")
      assert.strictEqual(w.executionState, "completed")
      assert.strictEqual(yield* replyOf(id), "\nDone it.\nstatus: failed\n\n## Remember\nuse bun")
      assert.deepStrictEqual(yield* sentBy(id), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "herdr's push of a status change runs the check: no poll, no ExecutionEnd",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      const w = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.executionState !== "open")
      assert.deepStrictEqual(pick(w), { status: "idle", executionState: "completed" })
    }),
    { hooked: ["pi"], statusEvents: true },
  )

  test(
    "a typed round ends like any round: its reply is kept and nothing is sent; typing during an open round records nothing",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* makeRepository
      const { id, sessions, db } = yield* spawnWorking(repo)
      const main = (yield* sql<{ id: string }>`SELECT entry_session_id AS id FROM project`)[0]!.id
      yield* sessions.userPrompt(main, "hello")
      yield* sessions.userPrompt(id, "do it")
      yield* sessions.userPrompt(id, "and this")
      const working = yield* sql<{
        input: string
        inbox: number | null
      }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(
        working.map((row) => [row.input, row.inbox !== null]),
        [["do it", true]],
      )
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: done it" })
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => !!w && w.executionState !== "open")

      const input = "a".repeat(2001)
      yield* sessions.userPrompt(id, input)
      const open = yield* sql<{
        input: string
        inbox: number | null
        status: string
      }>`SELECT input, inbox_id AS inbox, status FROM ${sql.literal(EXECUTIONS)} m
        WHERE session_id = ${id} AND status = 'working'`
      assert.deepStrictEqual(open, [{ input, inbox: null, status: "working" }])
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: typed" })
      const done = yield* until(
        db.getSession(id),
        (w): w is NonNullable<typeof w> => !!w && w.executionState !== "open",
      )
      assert.strictEqual(done.executionState, "completed")
      assert.strictEqual(yield* replyOf(id), "status: completed\nsummary: typed")
      assert.deepStrictEqual(yield* sentBy(id), [])
      assert.deepStrictEqual(yield* sql`SELECT id FROM inbox WHERE kind = 'notice'`.pipe(Effect.orDie), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "an explicit harness whose plugin is missing is refused with that problem",
    Effect.gen(function* () {
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository)))
      assert.strictEqual(refused._tag, "HarnessUnavailable")
      assert.include(refused.message, "vibest's pi plugin is missing")
      assert.strictEqual(refused.message.includes("claude"), false)
    }),
    { hooked: [] },
  )

  test(
    "spawn of a harness that is not logged in is refused, naming the model failure",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const refused = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository)))
      assert.strictEqual(refused._tag, "HarnessUnavailable")
      assert.include(refused.message, "Not logged in")
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
    "an ended execution waits for the hook (grace period), then is lost with a reason and the peek command, never the pane tail",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "lost", exitedAt: null })
      const row = yield* db.latestInbox(id, "notice")
      assert.include(row!.message, "the execution ended without a reply")
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
    "a session's in-memory flags, lock and live status go once it ends; resumed, its next execution ends as any execution does; archived, they go again with no check of its own",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      assert.deepInclude(yield* sessions.inMemory, { tracked: 1, locks: 0 })
      assert.strictEqual(yield* db.liveStatuses, 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* Effect.all([sessions.check(id), sessions.check(id), sessions.check(id)], { concurrency: "unbounded" })
      yield* settled
      assert.deepInclude(yield* db.getSession(id), { executionState: "failed" })
      assert.strictEqual(yield* db.liveStatuses, 0)
      yield* until(sessions.inMemory, (m) => m.tracked === 0 && m.locks === 0)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "open", exitedAt: null })
      yield* writeEnd(id, "pi", { text: "done again" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "completed" })
      assert.include(yield* replyOf(id), "done again")
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
      assert.deepInclude(yield* db.getSession(id), { executionState: "failed" })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.lengthOf(yield* db.pendingInbox(id), 0)
      assert.lengthOf(yield* db.inboxWithStatus(id, "failed"), 1)
      assert.strictEqual(yield* opens(), before)
      const notices = yield* sqlNotices(id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0], "exited during an execution")
      assert.include(notices[0], "Not delivered:\n\nqueued")
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
      assert.strictEqual(row.executionState, "failed")
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
