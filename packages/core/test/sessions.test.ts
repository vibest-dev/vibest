import { assert, describe } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt, startOf } from "@vibest/core/database/db-rows"
import { Integration } from "@vibest/core/integration"
import { Session } from "@vibest/core/session"
import { SessionLive } from "@vibest/core/session/live"
import { SessionLocks, terminalLock } from "@vibest/core/session/locks"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { atMostEntryTracked, replyOf, settleEntry, settled, until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import {
  entryOfProject,
  idleSession,
  sessionWorktree,
  spawnInput,
  spawnWorking,
  test,
  sqlNotices,
} from "./lib/sessions-helpers.ts"

const entriesAtOneTerminal = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const sessions = yield* Session.Service
  const db = yield* Db.Service
  const repo = yield* makeRepository
  const project = yield* projectOf(repo)
  const location = { runtime: RUNTIME, target: { id: "test/coord" } }

  const endEntry = (id: string) =>
    Effect.gen(function* () {
      yield* herdr.updateAgent("test/coord", (agent) => ({ ...agent, alive: false }))
      yield* sessions.check(id)
      yield* until(db.session.getSession(id), (now) => (now?.process?.endedAt ?? null) !== null)
    })

  const exitedEntry = (fresh: boolean) =>
    Effect.gen(function* () {
      const { sessionId } = yield* db.session.startRoot(project, "pi", fresh, location, {
        agent: "coordinator",
        projectDirectory: repo,
      })

      yield* herdr.seedAgent("test/coord")
      yield* endEntry(sessionId)
      yield* herdr.seedAgent("test/coord")

      return sessionId
    })

  return { exitedEntry, endEntry }
})

describe.concurrent("Session", () => {
  test(
    "a session's in-memory flags, lock and live status go once it ends; resumed, its next execution ends as any execution does; archived, they go again with no check of its own",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db, entryId } = yield* spawnWorking(yield* makeRepository)
      yield* settleEntry(sessions, entryId)
      const entryStatuses = (yield* (yield* SessionLive.Service).size).statuses - 1
      assert.deepInclude(yield* sessions.inMemory, { tracked: 2, locks: 0 })
      assert.strictEqual((yield* (yield* SessionLive.Service).size).statuses, entryStatuses + 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* Effect.all([sessions.check(id), sessions.check(id), sessions.check(id)], { concurrency: "unbounded" })
      yield* settled
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "failed")
      assert.strictEqual((yield* (yield* SessionLive.Service).size).statuses, entryStatuses)
      yield* until(sessions.inMemory, atMostEntryTracked)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("open"), (calls) => calls.some((c) => c.argv.at(-1)?.includes("next") === true))
      yield* sessions.check(id)
      const open = (yield* db.session.getSession(id))!
      assert.strictEqual(executionStateOf(open), "open")
      assert.isNull(exitedAt(open))
      yield* writeEnd(id, "pi", { text: "done again" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "completed")
      assert.include(yield* replyOf(id), "done again")
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* sessions.inMemory).tracked, 2)
      assert.deepInclude(yield* db.session.getSession(id), { status: "idle" })
      yield* sessions.archive(id)
      assert.strictEqual((yield* (yield* SessionLive.Service).size).statuses, entryStatuses)
      yield* untilVirtual(sessions.inMemory, atMostEntryTracked)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a check woken for a process that is not the session's current one leaves the session alone",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const current = (yield* db.session.getSession(id))!.process!.id
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id, current - 1)
      assert.isNull(exitedAt((yield* db.session.getSession(id))!))
      yield* sessions.check(id, current)
      assert.isNotNull(exitedAt((yield* db.session.getSession(id))!))
    }),
  )

  test(
    "a check that read the session before it started a new process does not end the new one",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const stateHeld = yield* herdr.hold("state", id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* stateHeld.reached
      const processHeld = yield* herdr.hold("process", id)
      yield* stateHeld.release()
      yield* processHeld.reached
      const old = (yield* db.session.getSession(id))!
      yield* db.session.endProcess(id, "restart")
      yield* db.session.startProcess(id, startOf(old))
      yield* processHeld.release()
      yield* Fiber.join(checking)
      const now = (yield* db.session.getSession(id))!.process!
      assert.notStrictEqual(now.id, old.process!.id)
      assert.isNull(now.endedAt)
    }),
  )

  test(
    "an entry session whose harness the runtime no longer shows is ended by its check, which drops the messages waiting on it; while it moves, a check leaves it",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const entryId = yield* entryOfProject(repo)
      const address = { id: "test/coord" }
      const waiting = (yield* db.inbox.insertSend(entryId, "waiting"))!
      assert.isTrue(yield* db.session.detachSession(entryId, RUNTIME, address))
      const ended = () => Effect.map(db.session.getSession(entryId), (row) => row!.process!.endedAt)
      yield* sessions.check(entryId)
      assert.isNull(yield* ended())
      yield* db.session.reattachSession(entryId)
      yield* sessions.check(entryId)
      assert.isNotNull(yield* ended())
      assert.deepStrictEqual(
        (yield* db.inbox.inboxWithStatus(entryId, "pending")).map((row) => row.id),
        [waiting.id],
      )
    }),
  )

  test(
    "a terminal exit bound to an entry session's new process after an in-place restart leaves it running while the runtime shows its harness",
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const db = yield* Db.Service
      const entryId = yield* entryOfProject(yield* makeRepository)
      yield* (yield* FakeRuntime).seedAgent("test/coord")
      const address = { id: "test/coord" }
      const next = yield* db.session.restartProcess(entryId)
      const processes = yield* db.session.processesAt(RUNTIME, address)
      assert.deepStrictEqual(processes, [{ sessionId: entryId, process: next! }])
      yield* bus.observe({ type: "terminal.exited", runtime: RUNTIME, terminal: address, processes })
      yield* settled

      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      const row = (yield* db.session.getSession(entryId))!
      assert.strictEqual(row.process!.id, next)
      assert.isNull(row.process!.endedAt)
      assert.isDefined(yield* db.inbox.insertSend(entryId, "after the exit"))
    }),
  )

  test(
    "a restarted session whose terminal reports no state shows idle once its harness reports ready; a state the runtime already reported stays",
    Effect.gen(function* () {
      const { id, db } = yield* idleSession(yield* makeRepository)
      const integration = yield* Integration.Service
      yield* db.session.restartProcess(id)
      assert.strictEqual((yield* db.session.getSession(id))!.status, "unknown")
      yield* integration.ready(id, 4343)
      assert.strictEqual((yield* db.session.getSession(id))!.status, "idle")

      yield* db.session.restartProcess(id)
      yield* db.session.setStatus(id, "blocked")
      yield* integration.ready(id, 4344)
      assert.strictEqual((yield* db.session.getSession(id))!.status, "blocked")
    }),
  )

  test(
    "archiving an entry session that exited leaves alone the terminal it recorded once a newer entry session used it, even after that one exited too",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const { exitedEntry, endEntry } = yield* entriesAtOneTerminal
      const old = yield* exitedEntry(false)
      yield* endEntry(yield* exitedEntry(true))
      assert.include(yield* sessions.archive(old, { keepWorktree: true }), { pane: "none" })
      assert.notDeepInclude(yield* herdr.callsTo("close"), { terminal: "test/coord" })
    }),
  )

  test(
    "a newer entry session cannot take the terminal while an archive of its last session decides to close it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const locks = yield* SessionLocks.Service
      const { exitedEntry } = yield* entriesAtOneTerminal
      const old = yield* exitedEntry(false)
      const looking = yield* herdr.hold("state", "test/coord")
      const archiving = yield* Effect.forkChild(sessions.archive(old, { keepWorktree: true }))
      yield* looking.reached
      const taken = yield* Ref.make(false)

      const claiming = yield* Effect.forkChild(
        locks.withLock(terminalLock(RUNTIME, { id: "test/coord" }))(Ref.set(taken, true)),
      )

      yield* TestClock.withLive(Effect.sleep("100 millis"))
      assert.isFalse(yield* Ref.get(taken))
      yield* looking.release()
      assert.include(yield* Fiber.join(archiving), { pane: "closed" })
      yield* Fiber.join(claiming)
      assert.isTrue(yield* Ref.get(taken))
    }),
  )

  test(
    "an entry session's exit, recorded while a newer process of it started, leaves the messages queued for the newer process",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const { id, sessions, db, entryId, row } = yield* spawnWorking(yield* makeRepository)
      const target = { id: "test/coord" }
      yield* runtime.updateAgent("test/coord", (agent) => ({ ...agent, alive: false }))
      const held = yield* runtime.hold("present", id)
      const checking = yield* Effect.forkChild(sessions.check(entryId))
      yield* held.reached
      assert.isNotNull((yield* db.session.getSession(entryId))!.process!.endedAt)

      const next = yield* db.session.startRoot(
        row.projectId,
        "pi",
        false,
        { runtime: RUNTIME, target },
        {
          agent: "coordinator",
        },
      )

      yield* runtime.seedAgent("test/coord")
      const message = (yield* db.inbox.insertSend(entryId, "for the new process"))!
      yield* held.release()
      yield* Fiber.join(checking)
      const now = (yield* db.session.getSession(entryId))!
      assert.strictEqual(now.process!.id, next.process)
      assert.isNull(now.process!.endedAt)
      assert.notInclude(
        (yield* db.inbox.inboxWithStatus(entryId, "dropped")).map((m) => m.id),
        message.id,
      )
    }),
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
      assert.lengthOf(yield* db.inbox.pendingInbox(id), 1)
      yield* processHeld.release()
      yield* Fiber.join(checking)

      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      yield* settled
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "failed")
      assert.isNotNull(exitedAt((yield* db.session.getSession(id))!))
      assert.lengthOf(yield* db.inbox.pendingInbox(id), 0)
      assert.lengthOf(yield* db.inbox.inboxWithStatus(id, "failed"), 1)
      assert.strictEqual(yield* opens(), before)
      const notices = yield* sqlNotices(id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0], "exited during an execution")
      assert.include(notices[0], "Not delivered:\n\nqueued")
    }),
  )

  test(
    "spawn without a harness and nothing to inherit is NoHarnessChosen",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { parentSessionId: _, ...input } = yield* spawnInput(repo)

      const error = yield* Effect.flip(
        (yield* Session.Service).spawn({
          ...input,
          harness: undefined,
          origin: { remote: "a".repeat(32), project: "p", reportTo: "origin-session" },
        }),
      )

      assert.strictEqual(error._tag, "NoHarnessChosen")
      assert.include(error.message, "no harness to inherit")
      assert.include(error.message, "this machine can run: ")
    }),
  )

  test(
    "an inherited harness that cannot run here fails naming whose it was, and lists the harnesses this machine can run",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const parent = yield* entryOfProject(repo)

      const error = yield* Effect.flip(
        (yield* Session.Service).spawn({ ...(yield* spawnInput(repo)), harness: undefined }),
      )

      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.include(error.message, `(inherited from ${parent})`)
      assert.match(error.message, /this machine can run: .*claude/)
      assert.notMatch(error.message, /can run: .*\bpi\b/)
    }),
    { unusable: ["pi"] },
  )

  test(
    "a git read that fails marks that session unknown and still lists the others",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const broken = yield* spawnWorking(repo)
      const fine = yield* spawnWorking(repo)
      yield* (yield* FakeGit).checkout(yield* sessionWorktree(broken.id), { stateError: "worktree unreadable" })
      const listed = yield* broken.sessions.list()
      const failed = listed.find((row) => row.id === broken.id)
      const other = listed.find((row) => row.id === fine.id)
      assert.strictEqual(failed?.git?.unknown, "Git.state: worktree unreadable")
      assert.strictEqual(other?.git?.saved, true)
      assert.strictEqual(other?.git?.unknown, undefined)
    }),
  )
})
