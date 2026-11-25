import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { archived, terminalOf, exitedAt, executionStateOf } from "@vibest/core/database/db-rows"
import { Integration } from "@vibest/core/integration"
import { Effect, Fiber, FileSystem } from "effect"
import { TestClock } from "effect/testing"

import { entryPending } from "./lib/directory.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import {
  claudeEnd,
  spawnWorking,
  idleSession,
  sessionWorktree,
  test,
  executionAndSentCounts,
  sqlNotices,
} from "./lib/sessions-helpers.ts"

describe.concurrent("Session", () => {
  test(
    "a resume first closes the terminal its exited harness left, and a start that fails places nothing more to close; the next resume on the same harness starts a process whose terminal report is accepted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      const left = terminalOf((yield* (yield* Db.Service).session.getSession(id))!)!.target["id"]!
      const placed = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open", id)
      yield* sessions.send(id, "again")
      yield* held.reached
      yield* held.release("failed")
      yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 1)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [{ terminal: left }])

      const notice = yield* until(sqlNotices(id), (rows) =>
        rows.some((message) => message.includes("A message to") && message.includes("again")),
      )

      assert.include(notice.at(-1)!, "open: failed")
      yield* sessions.send(id, "once more")
      const opens = yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 2)
      const reporter = Number(opens.at(-1)!.env.VIBEST_PROCESS)
      const db = yield* Db.Service
      assert.strictEqual(yield* db.session.currentProcessId(id), reporter)
      yield* until(
        db.session.getSession(id),
        (row) => row !== undefined && exitedAt(row) === null && terminalOf(row) !== null,
      )
      assert.strictEqual(yield* (yield* Integration.Service).ready(id, 4242, undefined, reporter), reporter)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a resume whose close of the left terminal fails opens no second terminal and keeps the old record; a left terminal already gone counts as closed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      const left = (yield* db.session.getSession(id))!
      const placed = (yield* herdr.callsTo("open")).length
      const notices = (yield* sqlNotices(id)).length
      const refused = yield* herdr.hold("close", terminalOf(left)!.target["id"]!)
      yield* sessions.send(id, "again")
      yield* refused.reached
      yield* refused.release("failed")
      yield* until(sqlNotices(id), (rows) => rows.length > notices)
      assert.strictEqual((yield* herdr.callsTo("open")).length, placed)
      assert.strictEqual(yield* db.session.currentProcessId(id), left.process!.id)

      const gone = yield* herdr.hold("close", terminalOf(left)!.target["id"]!)
      yield* sessions.send(id, "once more")
      yield* gone.reached
      yield* gone.release("not_found")
      yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 1)
    }),
  )

  test(
    "an execution end that lands after the terminal died, with a send queued: the exit is recorded and fails the send; nothing resumes the session",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.send(id, "queued")
      const placed = (yield* herdr.callsTo("open")).length
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* writeEnd(id, "pi", { text: "", error: "aborted", aborted: true })
      yield* untilVirtual(db.session.getSession(id), (row) => (row ? exitedAt(row) : undefined) != null)
      assert.deepStrictEqual(
        (yield* db.inbox.inboxWithStatus(id, "failed")).map((r) => r.message),
        ["queued"],
      )
      assert.lengthOf(yield* herdr.callsTo("open"), placed)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a stop on the condition of idleness leaves a session that got work since then running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const seen = (yield* db.session.getSession(id))!.lastActive
      yield* sessions.send(id, "more work")
      const out = yield* sessions.stop(id, { type: "plugin", plugin: "test" }, seen)
      assert.isFalse(out.stopped)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.isNull(exitedAt((yield* db.session.getSession(id))!))
      assert.isTrue((yield* sessions.stop(id, { type: "user" })).stopped)
    }),
  )

  test(
    "a Send accepted just before vibest archive does not bring the removed session back; its message fails once",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)

      const counts = Effect.all([herdr.callsTo("open"), herdr.callsTo("send")]).pipe(
        Effect.map((calls) => calls.map((c) => c.length)),
      )

      const before = yield* counts
      const held = yield* herdr.hold("state", id)
      const removing = yield* Effect.forkChild(sessions.archive(id, { keepWorktree: true }))
      yield* held.reached
      yield* sessions.send(id, "late")
      yield* held.release()
      assert.deepInclude(yield* Fiber.join(removing), { worktree: "kept" })
      yield* TestClock.withLive(Effect.sleep("100 millis"))
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* counts, before)
      const notices = yield* sqlNotices(id)
      const late = notices.filter((m) => m.endsWith("\n\nlate"))
      assert.strictEqual(late.length, 1)
      assert.include(late[0], "was not delivered: it was archived")
      assert.deepInclude(yield* sessions.archive(id), { worktree: "removed" })
    }),
  )

  test(
    "remove of a worktree that is gone, or not this repository's, reconciles its processes and leaves the directory alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* fs.remove(yield* sessionWorktree(a.id), { recursive: true })
      assert.deepInclude((yield* a.sessions.archive(a.id))!, { pane: "closed", workspace: "none", worktree: "gone" })
      assert.isNotNull(exitedAt((yield* a.db.session.getSession(a.id))!))

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      const fakeGit = yield* FakeGit
      yield* fakeGit.git.removeWorktree(repo, wb)
      yield* fs.makeDirectory(wb)
      yield* fakeGit.repository(wb)
      yield* fs.writeFileString(`${wb}/mine.txt`, "the user's")
      const out = (yield* b.sessions.archive(b.id))!
      assert.deepInclude(out, { worktree: "kept" })
      assert.match(out.reasons.join("\n"), /not a worktree of its repository/)
      assert.isTrue(yield* fs.exists(`${wb}/mine.txt`))
    }),
  )

  for (const harness of ["claude", "pi"] as const)
    test(
      `remove of a working ${harness} session: the aborted execution end of its interrupt is no result, written during the interrupt or after`,
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const aborted = harness === "claude" ? claudeEnd("aborted") : { text: "", error: "aborted", aborted: true }
        const during = yield* spawnWorking(repo, harness)
        const held = yield* herdr.hold("send", during.id)
        const removing = yield* Effect.forkChild(during.sessions.archive(during.id))
        yield* held.reached
        yield* writeEnd(during.id, harness, aborted, 60_000)
        yield* held.release()
        yield* Fiber.join(removing)
        const after = yield* spawnWorking(repo, harness)
        yield* after.sessions.archive(after.id)
        yield* writeEnd(after.id, harness, aborted, 60_000)
        yield* TestClock.adjust("2 minutes")

        for (const [entry, expected] of [
          [during, "interrupted"],
          [after, "lost"],
        ] as const) {
          const { id, sessions, db } = entry
          const row = (yield* db.session.getSession(id))!
          assert.isTrue(archived(row), id)
          yield* sessions.check(id)
          assert.deepStrictEqual(yield* executionAndSentCounts(id), { executions: 1, sent: 0 }, id)
          assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), expected, id)
          const pending = yield* entryPending(db, row.projectId)
          assert.ok(pending.every((item) => item.message.includes("was not delivered")))
        }
      }),
      harness === "pi" ? { hooked: ["pi"] } : undefined,
    )

  test(
    "interrupt that does not take: SessionBusy, the execution stays open, so the late aborted turn.complete is delivered as an interrupted result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* untilVirtual(
        Effect.sync(() => interrupting.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.strictEqual((yield* Effect.flip(Fiber.join(interrupting)))._tag, "SessionBusy")
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      yield* writeEnd(id, "claude", claudeEnd("aborted"))
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "interrupted")
      assert.isUndefined(yield* db.inbox.latestInbox(id, "notice"))
    }),
    { interruptIgnored: true },
  )

  test(
    "sessions of the same project share one VIBEST_SCRATCHPAD_DIR that exists on disk and survives archive",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      const b = yield* idleSession(repo)
      const rowA = (yield* a.db.session.getSession(a.id))!
      const rowB = (yield* b.db.session.getSession(b.id))!
      assert.strictEqual(rowA.projectId, rowB.projectId)

      const opens = yield* herdr.callsTo("open")
      const openA = opens.find((call) => call.env?.VIBEST_SESSION_ID === a.id)
      const openB = opens.find((call) => call.env?.VIBEST_SESSION_ID === b.id)
      const scratchA = openA?.env?.VIBEST_SCRATCHPAD_DIR
      const scratchB = openB?.env?.VIBEST_SCRATCHPAD_DIR
      assert.isDefined(scratchA)
      assert.strictEqual(scratchA, scratchB)
      assert.isTrue(scratchA!.endsWith(`/${rowA.projectId}/scratchpad`))
      assert.isTrue(yield* fs.exists(scratchA!))

      const handoff = `${scratchA}/handoff.md`
      yield* fs.writeFileString(handoff, "shared notes")
      yield* a.sessions.archive(a.id)
      assert.isTrue(yield* fs.exists(handoff))
      assert.strictEqual(yield* fs.readFileString(handoff), "shared notes")
    }),
  )
})
