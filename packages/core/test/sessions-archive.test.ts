import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { exitedAt, archived, executionStateOf } from "@vibest/core/database/db-rows"
import { Inbox } from "@vibest/core/inbox"
import { Sessions } from "@vibest/core/session"
import { SessionLive } from "@vibest/core/session/live"
import { Deferred, Effect, Fiber, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { HARNESSES, PULLING_CLAUDE, PULLING_PI } from "./lib/harnesses.ts"
import { lastSentBy, replyOf, settled, until, writeEnd } from "./lib/observe.ts"
import { makeRepository, type TestOptions } from "./lib/session.ts"
import {
  spawnInput,
  idleSession,
  sessionWorktree,
  test as plainTest,
  slowTest as plainSlowTest,
  sqlNotices,
} from "./lib/sessions-helpers.ts"

const withPulling = (options: TestOptions = {}): TestOptions => ({
  ...options,
  harnesses: [...HARNESSES, PULLING_PI, PULLING_CLAUDE],
})
const test: typeof plainTest = (name, program, options) => plainTest(name, program, withPulling(options))
const slowTest: typeof plainSlowTest = (name, program, options) => plainSlowTest(name, program, withPulling(options))

const makeArchiveGate = () => {
  let started: { readonly id: string; readonly done: Deferred.Deferred<void> } | undefined
  const options: TestOptions = {
    db: (db) => ({
      ...db,
      getSession: (id) =>
        db.getSession(id).pipe(
          Effect.tap(() => {
            const gate = started?.id === id ? started : undefined
            if (!gate) return Effect.void
            started = undefined
            return Deferred.succeed(gate.done, undefined)
          }),
        ),
    }),
  }
  const awaitStart = (id: string) =>
    Deferred.make<void>().pipe(
      Effect.map((done) => {
        started = { id, done }
        return Deferred.await(done)
      }),
    )
  return { options, awaitStart }
}

describe.concurrent("vibest run --archive-on-idle", () => {
  const archiveSession = (
    repo: string,
    entryHarness: "pulling-claude" | "pulling-pi" = "pulling-claude",
    input: { readonly share?: string } = {},
  ) =>
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        entryHarness,
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      yield* herdr.seedAgent("test/coord")
      const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), ...input, archive: true })
      yield* until(db.getSession(id), (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null))
      yield* sessions.check(id)
      yield* settled
      return { id, sessions, db, herdr, entryId: entry.sessionId, projectId: (yield* db.getSession(id))!.projectId }
    })

  const askEntry = (w: { readonly id: string; readonly entryId: string; readonly db: Db["Service"] }) =>
    w.db.insertSend(w.entryId, "a question", undefined, w.id)

  const finishExecution = (
    w: { readonly id: string; readonly sessions: Sessions["Service"]; readonly herdr: FakeRuntime["Service"] },
    text: string,
    error?: string,
  ) =>
    Effect.gen(function* () {
      yield* w.herdr.endExecution(w.id)
      yield* writeEnd(w.id, "pi", error ? { text, error } : { text })
      yield* w.sessions.check(w.id)
    })

  const entryTakes = (w: { readonly entryId: string }) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      return yield* until(inbox.take(w.entryId, undefined), (taken) => taken !== undefined)
    })

  const archivedRow = (db: Db["Service"], id: string) =>
    db.getSession(id).pipe(Effect.map((w) => w !== undefined && archived(w)))
  const letForkedArchiveRun = TestClock.withLive(Effect.sleep("100 millis"))
  const latestNotice = (id: string) => sqlNotices(id).pipe(Effect.map((n) => n.at(-1) ?? ""))

  test(
    "a message to the entry session that it took, after a completed execution, archives the session; a clean archive sends no notice (nothing to do); the answer stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const w = yield* archiveSession(yield* makeRepository)
      assert.isTrue(yield* (yield* SessionLive).archivesOnIdle(w.id))
      yield* askEntry(w)
      yield* finishExecution(w, "status: completed\nsummary: found it")
      yield* entryTakes(w)
      yield* until(archivedRow(w.db, w.id), (a) => a)
      yield* until(fs.exists(yield* sessionWorktree(w.id)), (e) => !e)
      yield* until(w.db.getSession(w.id), (r) => exitedAt(r!) !== null)
      yield* letForkedArchiveRun
      const rows = yield* sql<{
        kind: string
        status: string
      }>`SELECT m.kind AS kind, m.status AS status FROM inbox m WHERE m.sender_session_id = ${w.id} ORDER BY m.id`.pipe(
        Effect.orDie,
      )
      assert.deepStrictEqual(
        rows.map((r) => r.kind),
        ["send"],
      )
      assert.strictEqual(rows[0]!.status, "delivered")
      assert.include(yield* replyOf(w.id), "found it")
      assert.isNotNull(exitedAt((yield* w.db.getSession(w.id))!))
    }),
  )

  slowTest(
    "not archived while its message is only queued; archived once nothing is waiting",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const a = yield* archiveSession(repo)
      yield* askEntry(a)
      yield* finishExecution(a, "status: completed")
      yield* letForkedArchiveRun
      assert.strictEqual((yield* lastSentBy(a.id))!.status, "pending")
      assert.isFalse(yield* archivedRow(a.db, a.id))
      const b = yield* archiveSession(repo)
      yield* b.herdr.updateAgent("test/coord", (c) => ({ ...c, alive: false }))
      yield* finishExecution(b, "status: completed")
      yield* until(archivedRow(b.db, b.id), (a) => a)
    }),
  )

  test(
    "never after a failed execution, whose notice carries the error; the flag stays, so the next completed execution archives it",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const b = yield* archiveSession(repo)
      yield* finishExecution(b, "status: failed\nsummary: tests fail", "model_error")
      yield* entryTakes(b)
      const row = yield* b.db.latestInbox(b.id, "notice")
      assert.strictEqual(row!.status, "delivered")
      assert.include(row!.message, "execution ended with an error: model_error")
      yield* letForkedArchiveRun
      assert.isFalse(yield* archivedRow(b.db, b.id))
      yield* b.sessions.send(b.id, "the first one")
      yield* until(b.db.getSession(b.id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* finishExecution(b, "status: completed")
      yield* until(archivedRow(b.db, b.id), (x) => x)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a message queued when the execution ends: not archived, no notice (nothing to do), and the message is delivered",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* w.sessions.send(w.id, "one more thing")
      yield* finishExecution(w, "status: completed")
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.isFalse(yield* archivedRow(w.db, w.id))
      yield* w.sessions.check(w.id)
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "a message accepted while the archive runs wins: not archived, not failed, delivered",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* askEntry(w)
      yield* finishExecution(w, "status: completed")
      const held = yield* w.herdr.hold("state", w.id)
      yield* entryTakes(w)
      yield* held.reached
      yield* w.sessions.send(w.id, "one more thing")
      yield* held.release()
      yield* letForkedArchiveRun
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
      assert.isFalse(yield* archivedRow(w.db, w.id))
      assert.lengthOf(yield* w.db.inboxWithStatus(w.id, "failed"), 0)
      yield* until(w.db.inboxWithStatus(w.id, "delivered"), (rows) => rows.length === 1)
    }),
  )

  test(
    "the session turns busy after it went idle (the user typed in its pane): refused before the tombstone, still unarchived and usable",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* askEntry(w)
      yield* finishExecution(w, "status: completed")
      yield* settled
      const get = yield* w.herdr.hold("state", w.id, 2)
      yield* entryTakes(w)
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
      assert.isFalse(archived(row))
      assert.lengthOf(yield* w.herdr.callsTo("close"), 0)
      yield* w.herdr.endExecution(w.id)
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
      yield* askEntry(w)
      yield* finishExecution(w, "status: completed")
      yield* entryTakes(w)
      yield* held.reached
      assert.strictEqual(
        (yield* Effect.flip(w.sessions.send(w.id, "too late"))).message,
        `${w.id} was archived; run a new session`,
      )
      yield* held.release()
      yield* until(w.db.getSession(w.id), (r) => exitedAt(r!) !== null)
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
      assert.isFalse(yield* archivedRow(a.db, a.id))
      const sender = yield* archiveSession(repo)
      yield* askEntry(sender)
      yield* finishExecution(sender, "status: completed")
      assert.isFalse(yield* sender.db.archiveIfNoPending(sender.id))
      const b = yield* idleSession(repo)
      assert.isTrue(yield* b.db.archiveIfNoPending(b.id))
      assert.isUndefined(yield* b.db.insertSend(b.id, "late"))
      assert.deepStrictEqual(yield* b.db.pendingInbox(b.id), [])
    }),
  )

  test(
    "its harness already exited: archived once nothing it sent is waiting, and delivering the exit notice repeats nothing",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      yield* w.herdr.updateAgent(w.id, (a) => ({ ...a, alive: false }))
      yield* w.sessions.check(w.id)
      yield* writeEnd(w.id, "pi", { text: "status: completed" })
      yield* w.sessions.check(w.id)
      assert.isFalse(yield* archivedRow(w.db, w.id))
      yield* entryTakes(w)
      yield* until(archivedRow(w.db, w.id), (a) => a)
      yield* letForkedArchiveRun
      const notices = yield* sqlNotices(w.id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0], "exited")
    }),
  )

  const firstArchiveWaiting = (w: Effect.Success<ReturnType<typeof archiveSession>>) =>
    Effect.gen(function* () {
      yield* askEntry(w)
      yield* finishExecution(w, "status: completed\nsummary: first")
      yield* settled
      const check = yield* w.herdr.hold("state", w.id)
      const checking = yield* Effect.forkChild(w.sessions.check(w.id))
      yield* check.reached
      const looked = yield* archiveGate.awaitStart(w.id)
      yield* entryTakes(w)
      assert.strictEqual((yield* lastSentBy(w.id))!.status, "delivered")
      yield* looked
      yield* w.db.setStatus(w.id, "idle")
      yield* w.db.endExecution(w.id, { outcome: "completed" }, undefined)
      return { release: check.release().pipe(Effect.andThen(Fiber.join(checking))) }
    })

  const archiveGate = makeArchiveGate()

  const assertArchivesDone = (w: Effect.Success<ReturnType<typeof archiveSession>>) =>
    Effect.gen(function* () {
      const sends = (yield* w.herdr.callsTo("send")).length
      yield* w.sessions.check(w.id)
      assert.lengthOf(yield* w.herdr.callsTo("send"), sends)
    })

  test(
    "a newer completed execution while the first one's archive waits for the lock: archived once, no notice",
    Effect.gen(function* () {
      const w = yield* archiveSession(yield* makeRepository)
      const first = yield* firstArchiveWaiting(w)
      yield* first.release
      yield* until(archivedRow(w.db, w.id), (a) => a)
      yield* assertArchivesDone(w)
      assert.lengthOf(yield* w.herdr.callsTo("close"), 1)
      assert.deepStrictEqual(yield* sqlNotices(w.id), [])
    }),
    archiveGate.options,
  )

  test(
    "an owner started with --archive-on-idle keeps its worktree while a borrower is live",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* archiveSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: owner.id })
      yield* until(
        owner.db.getSession(id),
        (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null),
      )
      yield* askEntry(owner)
      yield* finishExecution(owner, "status: completed")
      yield* entryTakes(owner)
      const notice = yield* until(latestNotice(owner.id), (m) => m.includes("archived ("))
      assert.include(notice, `worktree kept: session ${id} still works in it`)
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(owner.id)))
    }),
  )

  test(
    "run --share: --keep-worktree keeps the directory at that archive only; the last session's archive removes it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const b = yield* archiveSession(repo, "pulling-claude", { share: owner.id })
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
