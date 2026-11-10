import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Sessions } from "@vibest/core/sessions"
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { settled, until, untilVirtual, writeResult } from "./lib/observe.ts"
import { makeRepository, type TestOptions } from "./lib/session.ts"
import { spawnInput, idleSession, sessionWorktree, test, slowTest, sqlNotices } from "./lib/sessions-helpers.ts"

let archiveStartedSignal: { readonly id: string; readonly done: Deferred.Deferred<void> } | undefined
const gated: TestOptions = {
  db: (db) => ({
    ...db,
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

describe.concurrent("vibest run --archive-on-idle", () => {
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
    "not archived while the result is only queued or its poll lease is released; archived once the result is dropped or failed, since nothing is waiting",
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
      yield* until(archived(b.db, b.id), (a) => a)
      const c = yield* archiveSession(repo, "pi")
      yield* finishTurn(c, "status: completed")
      yield* inbox.stream(c.projectId).pipe(Stream.take(1), Stream.runDrain)
      yield* letForkedArchiveRun
      assert.strictEqual((yield* c.db.latestInbox(c.id, "result"))!.status, "failed")
      yield* until(archived(c.db, c.id), (a) => a)
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
      const sender = yield* archiveSession(repo)
      yield* finishTurn(sender, "status: completed")
      assert.isFalse(yield* sender.db.archiveIfNoPending(sender.id))
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
      yield* ackResult(w)
      yield* letForkedArchiveRun
      yield* w.sessions.check(w.id)
      yield* letForkedArchiveRun
      const skips = (yield* sqlNotices(w.id)).filter((m) => m.includes("not archived"))
      assert.lengthOf(skips, 1)
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
    "an owner started with --archive-on-idle keeps its worktree while a borrower is live",
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
