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
    "a resume whose start fails closes the pane it placed; the next resume on the same harness starts a process whose terminal report is accepted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
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
      yield* sessions.send(id, "once more")
      const opens = yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 2)
      const reporter = Number(opens.at(-1)!.env.VIBEST_PROCESS)
      const db = yield* Db
      assert.strictEqual(yield* db.currentProcessId(id), reporter)
      yield* until(db.getSession(id), (row) => row !== undefined && exitedAt(row) === null && terminalOf(row).id !== "")
      assert.strictEqual(yield* (yield* Integration.Service).ready(id, 4242, undefined, reporter), reporter)
    }),
    { hooked: ["pi"] },
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
      yield* untilVirtual(db.getSession(id), (row) => (row ? exitedAt(row) : undefined) != null)
      assert.deepStrictEqual(
        (yield* db.inboxWithStatus(id, "failed")).map((r) => r.message),
        ["queued"],
      )
      assert.lengthOf(yield* herdr.callsTo("open"), placed)
    }),
    { hooked: ["pi"] },
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
    "remove of a worktree that is gone, or not this repository's, reconciles its processes and leaves the directory alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* fs.remove(yield* sessionWorktree(a.id), { recursive: true })
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { pane: "closed", workspace: "none", worktree: "gone" })
      assert.isNotNull(exitedAt((yield* a.db.getSession(a.id))!))

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      const fakeGit = yield* FakeGit
      yield* fakeGit.git.removeWorktree(repo, wb)
      yield* fs.makeDirectory(wb)
      yield* fakeGit.repository(wb)
      yield* fs.writeFileString(`${wb}/mine.txt`, "the user's")
      const out = (yield* b.sessions.remove(b.id))!
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
        const removing = yield* Effect.forkChild(during.sessions.remove(during.id))
        yield* held.reached
        yield* writeEnd(during.id, harness, aborted, 60_000)
        yield* held.release()
        yield* Fiber.join(removing)
        const after = yield* spawnWorking(repo, harness)
        yield* after.sessions.remove(after.id)
        yield* writeEnd(after.id, harness, aborted, 60_000)
        yield* TestClock.adjust("2 minutes")
        for (const { id, sessions, db } of [during, after]) {
          const row = (yield* db.getSession(id))!
          assert.isTrue(archived(row), id)
          yield* sessions.check(id)
          assert.deepStrictEqual(yield* executionAndSentCounts(id), { executions: 1, sent: 0 }, id)
          assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "interrupted", id)
          assert.deepStrictEqual(yield* entryPending(db, row.projectId), [])
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
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "open")
      yield* writeEnd(id, "claude", claudeEnd("aborted"))
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(executionStateOf((yield* db.getSession(id))!), "interrupted")
      assert.isUndefined(yield* db.latestInbox(id, "notice"))
    }),
    { interruptIgnored: true },
  )
})
