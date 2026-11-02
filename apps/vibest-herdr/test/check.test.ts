// The builtin check rule: a writing subagent's round reaches its parent only after the configured command passes.
import process from "node:process"

import { assert, describe, it } from "@effect/vitest"
import { checkPlugin, runCheck } from "@vibest/core/check"
import { Db } from "@vibest/core/db"
import { Layout, worktreePath } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { Sessions } from "@vibest/core/sessions"
import { repositoryKey } from "@vibest/core/worktree"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Duration, Effect, Fiber, FileSystem, Path, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime, makeRepository, testLayer, type TestServices, until, untilVirtual, writeResult } from "./fakes.ts"

const configured = (command: string, attempts: number) => ({
  plugins: [{ plugin: checkPlugin, options: { command, attempts } }],
})

const test = (
  name: string,
  command: string,
  attempts: number,
  program: Effect.Effect<void, unknown, TestServices | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>,
) => it.effect(name, () => program.pipe(Effect.provide(testLayer(configured(command, attempts)))))

const spawnInput = (repo: string) =>
  Effect.map(repositoryKey(repo), (key) => ({
    machine: { id: "local" },
    root: repo,
    key,
    name: "task",
    prompt: "do it",
    harness: "pi" as const,
  }))

const spawnWorking = (repo: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    const herdr = yield* FakeRuntime
    yield* db.coordinatorLaunch(yield* repositoryKey(repo), "pi", false, {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    })
    const { id } = yield* sessions.spawn(yield* spawnInput(repo))
    yield* until(db.getSession(id), (row) => !!row && (row.startedAt !== null || row.exitedAt !== null))
    yield* sessions.check(id)
    return { id, sessions, db, herdr }
  })

/** The check command runs outside the lock, so wait until it has pasted a retry or delivered the result. */
const finish = (
  w: {
    readonly id: string
    readonly sessions: Sessions["Service"]
    readonly db: Db["Service"]
    readonly herdr: FakeRuntime["Service"]
  },
  text: string,
  offsetMs: number,
) =>
  Effect.gen(function* () {
    const before = (yield* promptsTo(w.herdr, w.id)).length
    yield* writeResult(w.id, "pi", { text }, offsetMs)
    yield* w.herdr.endTurn(w.id)
    yield* w.sessions.check(w.id)
    yield* until(
      Effect.all({ prompts: promptsTo(w.herdr, w.id), result: w.db.latestInbox(w.id, "result") }),
      (settled) => settled.result !== undefined || settled.prompts.length > before,
    )
  })

const promptsTo = (herdr: FakeRuntime["Service"], id: string) =>
  Effect.gen(function* () {
    const terminal = (yield* herdr.agent(id))?.terminal
    return (yield* herdr.callsTo("send")).filter((call) => call.terminal === terminal)
  })

const messageRows = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      status: string
      input: string
    }>`SELECT status, input FROM message WHERE session_id = ${id} ORDER BY id`.pipe(Effect.orDie)
  })

describe("check rule", () => {
  test(
    "pass: a passing check lets the round result go to the parent",
    "touch .checked",
    3,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* finish(w, "status: completed\nsummary: done it", 1000)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.include(row!.message, "done it")
      assert.strictEqual(row!.details.check, undefined)
      assert.strictEqual((row!.details.acceptance as ReadonlyArray<{ readonly summary: string }>)[0]?.summary, "ok")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, 1)
      const cwd = worktreePath(yield* Layout, (yield* w.db.getSession(w.id))!)!
      assert.isTrue(yield* fs.exists(path.join(cwd, ".checked")))
      assert.isFalse(yield* fs.exists(path.join(repo, ".checked")))
    }),
  )

  test(
    "fail-then-pass: a failing check sends the output tail, and a later pass lets the result go",
    'n=0; [ -f .check-n ] && n=$(cat .check-n); n=$((n+1)); printf \'%s\\n\' "$n" > .check-n; printf \'check-fail-%s\\n\' "$n"; [ "$n" -ge 2 ]',
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* finish(w, "status: completed\nsummary: first", 1000)
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.strictEqual((yield* w.db.getSession(w.id))!.turnState, "open")
      const sent = yield* promptsTo(w.herdr, w.id)
      assert.strictEqual(sent.length, 2)
      assert.include(sent[1]!.text, "check-fail-1")
      yield* finish(w, "status: completed\nsummary: second", 2000)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.include(row!.message, "second")
      assert.strictEqual(row!.details.check, undefined)
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, 2)
    }),
  )

  test(
    "fail past attempts: the result goes to the parent marked check failed",
    "printf 'CHECK_FAIL\\n'; exit 1",
    2,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* finish(w, "status: completed\nsummary: still red", 1000)
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.include((yield* promptsTo(w.herdr, w.id))[1]!.text, "CHECK_FAIL")
      yield* finish(w, "status: completed\nsummary: still red", 2000)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.include(row!.message, "still red")
      assert.strictEqual(row!.details.check, undefined)
      assert.strictEqual(row!.details.status, "failed")
      assert.include(row!.message, "check failed")
      assert.include(row!.message, "CHECK_FAIL")
      assert.deepStrictEqual(
        (row!.details.acceptance as ReadonlyArray<{ readonly outcome: string }>).map((entry) => entry.outcome),
        ["fail", "fail"],
      )
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, 2)
    }),
  )

  test(
    "the main agent is not checked",
    "touch .checked",
    1,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const decision = yield* (yield* Plugins).idle({
        sessionId: "main",
        agentType: "main",
        directory: dir,
        answer: "hi",
        checkAttempts: 0,
        ran: undefined,
      })
      assert.strictEqual(decision.prompt, undefined)
      assert.strictEqual(decision.command, undefined)
      assert.isFalse(yield* fs.exists(path.join(dir, ".checked")))
    }),
  )

  test(
    "the same result is checked once",
    'n=0; [ -f .check-n ] && n=$(cat .check-n); n=$((n+1)); printf %s "$n" > .check-n; echo fail; exit 1',
    3,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      const before = (yield* promptsTo(w.herdr, w.id)).length
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: once" }, 1000)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
      yield* w.sessions.check(w.id)
      yield* until(promptsTo(w.herdr, w.id), (calls) => calls.length > before)
      const cwd = worktreePath(yield* Layout, (yield* w.db.getSession(w.id))!)!
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".check-n")), "1")
      assert.strictEqual((yield* w.db.getSession(w.id))!.metadata.check?.attempts, 1)
    }),
  )

  test(
    "restart mid-attempts keeps the count",
    "echo FAIL; exit 1",
    2,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* finish(w, "status: completed\nsummary: first", 1000)
      const mid = (yield* w.db.getSession(w.id))!.metadata.check
      assert.strictEqual(mid?.attempts, 1)
      assert.strictEqual(mid?.acceptance.length, 1)
      assert.strictEqual(mid?.acceptance[0]?.outcome, "fail")
      const fresh = yield* Plugins.make([
        { source: "test:check", revision: "again", options: { command: "exit 1", attempts: 2 }, plugin: checkPlugin },
      ]).pipe(Effect.provideContext(yield* Effect.context<TestServices>()))
      const replay = yield* fresh.idle({
        sessionId: w.id,
        agentType: "general",
        directory: repo,
        answer: "first",
        checkAttempts: mid!.attempts,
        ran: { ok: false, tail: "stored" },
      })
      // A new plugin closure uses the stored count: one attempt of two still retries, and does not ask to run again.
      assert.strictEqual(replay.command, undefined)
      assert.strictEqual(replay.prompt, "stored")
      const spent = yield* fresh.idle({
        sessionId: w.id,
        agentType: "general",
        directory: repo,
        answer: "first",
        checkAttempts: 2,
        ran: { ok: false, tail: "stored" },
      })
      assert.strictEqual(spent.prompt, undefined)
      assert.strictEqual(spent.output, "stored")
      yield* finish(w, "status: completed\nsummary: second", 2000)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.status, "failed")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, 2)
      assert.strictEqual((yield* w.db.getSession(w.id))!.metadata.check, undefined)
    }),
  )

  test(
    "interrupt with a pending check delivers it as failed and does not prompt",
    "printf 'CHECK_FAIL\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: red" }, 1000)
      yield* w.herdr.endTurn(w.id)
      const reply = yield* w.sessions.interrupt(w.id)
      assert.include(reply.message, "delivered")
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.status, "failed")
      assert.strictEqual(row!.details.error, "check interrupted")
      assert.notInclude(row!.message, "CHECK_FAIL")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, 1)
      assert.strictEqual((yield* w.db.getSession(w.id))!.turnState, "failed")
      assert.deepStrictEqual((yield* w.herdr.callsTo("send")).slice(1), [])
    }),
  )

  test(
    "interrupt while the check command runs returns at once, kills it and delivers",
    "echo $$ > .check.pid; sleep 300",
    3,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: slow" }, 1000)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
      const cwd = worktreePath(yield* Layout, (yield* w.db.getSession(w.id))!)!
      const pidFile = path.join(cwd, ".check.pid")
      yield* until(fs.exists(pidFile), (written) => written)
      const pid = Number(yield* fs.readFileString(pidFile))
      // Not the check's own timeout (minutes): interrupt stops the command fiber instead of joining it.
      const started = Date.now()
      const reply = yield* w.sessions.interrupt(w.id)
      assert.isTrue(Date.now() - started < 10_000)
      assert.include(reply.message, "delivered")
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.error, "check interrupted")
      assert.strictEqual((yield* w.db.getSession(w.id))!.turnState, "failed")
      yield* until(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
        (dead) => dead,
      )
    }),
  )

  test(
    "a blank command fails plugin setup",
    "   ",
    1,
    Effect.gen(function* () {
      const row = (yield* (yield* Plugins).list).find((plugin) => plugin.id === "check")
      assert.strictEqual(row?.status, "failed")
      assert.match(row?.error ?? "", /command/)
    }),
  )

  test(
    "empty output: a pass says ok and a failure says check failed",
    "true",
    1,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      assert.deepStrictEqual(yield* runCheck("exit 0", repo), { ok: true, tail: "ok" })
      assert.deepStrictEqual(yield* runCheck("exit 1", repo), { ok: false, tail: "check failed" })
    }),
  )

  test(
    "huge output keeps only the tail",
    "true",
    1,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const bin = JSON.stringify(process.execPath)
      const lines = yield* runCheck(
        `${bin} -e ${JSON.stringify("for (let i = 0; i < 80; i++) console.log(String(i).padStart(2, '0'))")}`,
        repo,
      )
      assert.strictEqual(lines.ok, true)
      assert.strictEqual(lines.tail.split("\n").length, 30)
      assert.ok(lines.tail.startsWith("50"))
      assert.strictEqual(lines.tail.slice(-2), "79")
      assert.notInclude(lines.tail, "49")
      const huge = yield* runCheck(`${bin} -e ${JSON.stringify('process.stdout.write("B".repeat(1024 * 1024))')}`, repo)
      assert.strictEqual(huge.ok, true)
      assert.strictEqual(huge.tail.length, 4096)
      assert.ok(huge.tail.startsWith("BBBB"))
      assert.notInclude(huge.tail, "C")
    }),
  )

  test(
    "a failed continuation paste is retried later and the round is not lost",
    "printf 'CHECK_FAIL\\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
      const before = yield* w.db.getSession(w.id)
      const held = yield* w.herdr.hold("send", w.id)
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: kept" }, 1000)
      yield* w.sessions.check(w.id)
      // The check command races a virtual timeout; pump the clock or that race never observes the process exit.
      const pump = yield* Effect.forkChild(
        Effect.forever(
          TestClock.withLive(Effect.sleep("10 millis")).pipe(Effect.andThen(TestClock.adjust("500 millis"))),
        ),
      )
      yield* held.reached
      yield* Fiber.interrupt(pump)
      const during = yield* w.db.getSession(w.id)
      assert.strictEqual(during!.turnPromptedAt, before!.turnPromptedAt)
      assert.strictEqual(during!.turnState, "open")
      yield* held.release("unreachable")
      // The attempted paste settles: the notice is only for a paste that was sent and not confirmed.
      yield* until(w.db.latestInbox(w.id, "notice"), (row) => !!row && row.message.includes("could not be pasted"))
      const failed = yield* w.db.getSession(w.id)
      assert.strictEqual(failed!.turnState, "open")
      assert.strictEqual(failed!.turnPromptedAt, before!.turnPromptedAt)
      assert.strictEqual(failed!.metadata.check?.attempts, 1)
      assert.strictEqual(failed!.metadata.check?.ran?.ok, false)
      assert.deepStrictEqual(yield* messageRows(w.id), [{ status: "working", input: "do it" }])
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      const prompts = (yield* promptsTo(w.herdr, w.id)).length
      yield* Effect.forkChild(w.sessions.check(w.id))
      // The retry needs the poll's clock: advance until the next paste lands.
      yield* untilVirtual(promptsTo(w.herdr, w.id), (calls) => calls.length > prompts)
      const after = yield* w.db.getSession(w.id)
      assert.strictEqual(after!.turnState, "open")
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.include((yield* promptsTo(w.herdr, w.id)).at(-1)!.text, "CHECK_FAIL")
    }),
  )

  test(
    "a result written while the agent is still working, then idle with no new seq, is retried and not lost",
    "printf 'CHECK_FAIL\\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      const before = yield* w.db.getSession(w.id)
      const prompts = (yield* promptsTo(w.herdr, w.id)).length
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: kept" }, 1000)
      yield* w.sessions.check(w.id)
      yield* until(w.db.getSession(w.id), (row) => row?.metadata.check?.ran !== undefined)
      // Still working: one status read, no wait, no notice. A pre-existing working status is not a confirm.
      yield* TestClock.adjust("9 seconds")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, prompts)
      assert.notInclude((yield* w.db.latestInbox(w.id, "notice"))?.message ?? "", "could not be pasted")
      const waiting = yield* w.db.getSession(w.id)
      assert.strictEqual(waiting!.turnPromptedAt, before!.turnPromptedAt)
      assert.strictEqual(waiting!.turnState, "open")
      yield* w.herdr.updateAgent(w.id, (agent) => ({ ...agent, status: "idle" }))
      yield* w.sessions.check(w.id)
      yield* until(promptsTo(w.herdr, w.id), (calls) => calls.length > prompts)
      yield* until(w.db.getSession(w.id), (row) => !!row && row.turnPromptedAt !== before!.turnPromptedAt)
      const after = yield* w.db.getSession(w.id)
      assert.strictEqual(after!.turnState, "open")
      assert.deepStrictEqual(yield* messageRows(w.id), [{ status: "working", input: "do it" }])
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.include((yield* promptsTo(w.herdr, w.id)).at(-1)!.text, "CHECK_FAIL")
    }),
  )

  test(
    "a continuation the agent never starts keeps the one working message and is pasted again",
    "printf 'CHECK_FAIL\\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      const before = yield* w.db.getSession(w.id)
      yield* w.herdr.endTurn(w.id)
      yield* w.herdr.updateAgent(w.id, (agent) => ({ ...agent, registerPrompt: false }))
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: kept" }, 1000)
      yield* w.sessions.check(w.id)
      yield* untilVirtual(
        w.db.latestInbox(w.id, "notice"),
        (row) => !!row && row.message.includes("could not be pasted"),
      )
      const stalled = yield* w.db.getSession(w.id)
      assert.strictEqual(stalled!.turnState, "open")
      assert.strictEqual(stalled!.turnPromptedAt, before!.turnPromptedAt)
      assert.strictEqual(stalled!.metadata.check?.attempts, 1)
      assert.deepStrictEqual(yield* messageRows(w.id), [{ status: "working", input: "do it" }])
      assert.ok((yield* promptsTo(w.herdr, w.id)).length >= 3)
      const prompts = (yield* promptsTo(w.herdr, w.id)).length
      yield* Effect.forkChild(w.sessions.check(w.id))
      yield* untilVirtual(promptsTo(w.herdr, w.id), (calls) => calls.length > prompts)
      const again = yield* w.db.getSession(w.id)
      assert.strictEqual(again!.turnState, "open")
      assert.strictEqual(again!.turnPromptedAt, before!.turnPromptedAt)
      assert.deepStrictEqual(yield* messageRows(w.id), [{ status: "working", input: "do it" }])
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.include((yield* promptsTo(w.herdr, w.id)).at(-1)!.text, "CHECK_FAIL")
    }),
  )

  test(
    "agent gone after a red check finishes the round and does not notice",
    "printf 'CHECK_FAIL\\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      const prompts = (yield* promptsTo(w.herdr, w.id)).length
      yield* w.herdr.updateAgent(w.id, (agent) => ({ ...agent, alive: false }))
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: red" }, 1000)
      yield* w.sessions.check(w.id)
      yield* until(w.db.getSession(w.id), (row) => row?.turnState === "failed")
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.status, "failed")
      assert.include(row!.message, "the session exited")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, prompts)
      assert.notInclude((yield* w.db.latestInbox(w.id, "notice"))?.message ?? "", "could not be pasted")
      assert.strictEqual((yield* w.db.getSession(w.id))!.turnState, "failed")
    }),
  )

  test(
    "interrupt during the wait delivers failed and does not paste",
    "printf 'CHECK_FAIL\\n'; exit 1",
    3,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      const prompts = (yield* promptsTo(w.herdr, w.id)).length
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: red" }, 1000)
      yield* w.sessions.check(w.id)
      yield* until(w.db.getSession(w.id), (row) => row?.metadata.check?.ran !== undefined)
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, prompts)
      assert.notInclude((yield* w.db.latestInbox(w.id, "notice"))?.message ?? "", "could not be pasted")
      const reply = yield* w.sessions.interrupt(w.id)
      assert.match(reply.message, /check failed|delivered/)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.status, "failed")
      assert.strictEqual(row!.details.error, "check failed")
      assert.include(row!.message, "CHECK_FAIL")
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, prompts)
      assert.notInclude((yield* w.db.latestInbox(w.id, "notice"))?.message ?? "", "could not be pasted")
      yield* w.herdr.updateAgent(w.id, (agent) => ({ ...agent, status: "idle" }))
      yield* w.sessions.check(w.id)
      assert.strictEqual((yield* promptsTo(w.herdr, w.id)).length, prompts)
      assert.notStrictEqual((yield* w.db.getSession(w.id))!.turnState, "open")
    }),
  )

  test(
    "interrupt resets attempts so the next task still gets a retry",
    "printf 'CHECK_FAIL\\n'; exit 1",
    2,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* finish(w, "status: completed\nsummary: first", 1000)
      assert.strictEqual((yield* w.db.getSession(w.id))!.metadata.check?.attempts, 1)
      const reply = yield* w.sessions.interrupt(w.id)
      assert.include(reply.message, "interrupted")
      assert.strictEqual((yield* w.db.getSession(w.id))!.metadata.check, undefined)
      yield* w.sessions.send(w.id, "next")
      yield* until(promptsTo(w.herdr, w.id), (calls) => calls.some((call) => call.text === "next"))
      yield* finish(w, "status: completed\nsummary: second", 1000)
      assert.isUndefined(yield* w.db.latestInbox(w.id, "result"))
      assert.strictEqual((yield* w.db.getSession(w.id))!.metadata.check?.attempts, 1)
      assert.include((yield* promptsTo(w.herdr, w.id)).at(-1)!.text, "CHECK_FAIL")
    }),
  )

  test(
    "a harness failure is delivered as that error and the check does not run",
    "touch .checked",
    3,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* writeResult(w.id, "pi", { text: "status: failed\nsummary: limited", error: "model_not_found" }, 1000)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
      const row = yield* w.db.latestInbox(w.id, "result")
      assert.strictEqual(row!.details.error, "model_not_found")
      assert.strictEqual(row!.details.status, "failed")
      assert.notInclude(row!.message, "check failed")
      assert.include(row!.message, "model_not_found")
      const cwd = worktreePath(yield* Layout, (yield* w.db.getSession(w.id))!)!
      assert.isFalse(yield* fs.exists(path.join(cwd, ".checked")))
    }),
  )

  test(
    "remove kills the running check",
    "echo $$ > .check.pid; sleep 300",
    1,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const w = yield* spawnWorking(repo)
      yield* writeResult(w.id, "pi", { text: "status: completed\nsummary: running" }, 1000)
      yield* w.herdr.endTurn(w.id)
      yield* w.sessions.check(w.id)
      const cwd = worktreePath(yield* Layout, (yield* w.db.getSession(w.id))!)!
      const pidFile = path.join(cwd, ".check.pid")
      yield* until(fs.exists(pidFile), (written) => written)
      const pid = Number(yield* fs.readFileString(pidFile))
      yield* w.sessions.remove(w.id)
      yield* until(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
        (dead) => dead,
      )
    }),
  )

  test(
    "timeout kills the command's children",
    "true",
    1,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const pidFile = path.join(dir, "child.pid")
      const child = `process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`
      const parent = `const {spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)`
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parent)} ${JSON.stringify(pidFile)}`
      const fiber = yield* Effect.forkChild(runCheck(command, dir, Duration.seconds(1)))
      yield* until(fs.exists(pidFile), (written) => written)
      yield* TestClock.adjust("2 seconds")
      const ran = yield* Fiber.join(fiber)
      assert.strictEqual(ran.ok, false)
      const pid = Number(yield* fs.readFileString(pidFile))
      yield* until(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
        (dead) => dead,
      )
    }),
  )
})
