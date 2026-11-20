import { SqliteClient } from "@effect/sql-sqlite-bun"
import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Concurrency } from "@vibest/core/concurrency"
import { Db, SQL_NAMES } from "@vibest/core/database/db"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { EntrySession } from "@vibest/core/session/entry"
import type { HarnessId } from "@vibest/schema/session"
import { Clock, Effect, FileSystem, Layer, Ref, Stream } from "effect"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf, tempDirectory } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { HARNESSES, PULLING_PI } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, runtimeNode, sessionLayer } from "./lib/session.ts"
import { test as plainTest } from "./lib/sessions-helpers.ts"
import { services } from "./platform/bun.ts"

const test: typeof plainTest = (name, program, options) =>
  plainTest(name, program, { ...options, harnesses: [...HARNESSES, PULLING_PI] })

const unset = { provider: undefined, model: undefined, routing: undefined, pid: undefined }

const limitTo = (max: number) => Effect.flatMap(Concurrency.Service, (c) => c.configure([{ max }]))

const entryIn = (directory: string, terminal: string, harness: HarnessId = PULLING_PI.id) =>
  Effect.gen(function* () {
    const db = yield* Db.Service

    const { sessionId } = yield* db.session.startEntry(
      yield* projectOf(directory),
      harness,
      false,
      { runtime: RUNTIME, address: { machine: "local", id: terminal } },
      { agent: "general" },
    )

    yield* (yield* FakeRuntime).seedAgent(terminal)
    yield* (yield* Integration.Service).ready(sessionId, undefined)

    return sessionId
  })

const pullingEntry = (terminal: string) => Effect.flatMap(makeRepository, (repo) => entryIn(repo, terminal))

const holdSlot = (terminal: string) =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    const worker = yield* pullingEntry(terminal)
    yield* (yield* Session.Service).userPrompt(worker, "hold the slot")
    const held = (yield* db.session.openExecution(worker))!

    return { worker, release: db.session.closeExecution(worker, held, "completed") }
  })

describe("one admission queue under a concurrency limit", () => {
  test(
    "an idle pulling session is woken and takes its send once another session frees the slot",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const inbox = yield* Inbox.Service
      const sessions = yield* Session.Service
      yield* limitTo(1)
      const worker = yield* pullingEntry("test/worker")
      const idle = yield* pullingEntry("test/a")
      yield* sessions.userPrompt(worker, "hold the slot")
      const held = (yield* db.session.openExecution(worker))!
      yield* inbox.stream(idle).pipe(
        Stream.runForEach(() => inbox.take(idle, undefined)),
        Effect.forkScoped,
      )
      yield* sessions.deliverTo(idle, "follow-up")
      yield* until(db.inbox.waitingSessions(), (ids) => ids.includes(idle))
      assert.lengthOf(yield* db.inbox.pendingInbox(idle), 1)

      yield* db.session.closeExecution(worker, held, "completed")
      yield* until(db.inbox.pendingInbox(idle), (rows) => rows.length === 0)
      assert.isDefined(yield* db.session.openExecution(idle))
    }),
  )

  test(
    "a later pulling session cannot take the freed slot ahead of an older waiting one",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const inbox = yield* Inbox.Service
      const sessions = yield* Session.Service
      yield* limitTo(1)
      const { release } = yield* holdSlot("test/worker")
      const older = yield* pullingEntry("test/a")
      const newer = yield* pullingEntry("test/b")
      yield* sessions.deliverTo(older, "older")
      yield* sessions.deliverTo(newer, "newer")
      assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [older, newer])

      yield* release
      assert.isUndefined(yield* inbox.take(newer, undefined))
      assert.strictEqual((yield* inbox.take(older, undefined))?.content, "older")
    }),
  )

  test(
    "two messages queued in the same millisecond keep their arrival order, also after the read model is rebuilt",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      yield* limitTo(1)
      yield* holdSlot("test/worker")
      const [first, second] = [yield* pullingEntry("test/a"), yield* pullingEntry("test/b")].sort().reverse()
      const at = yield* Clock.currentTimeMillis

      const frozen = Effect.provideService(Clock.Clock, {
        ...(yield* Clock.Clock),
        currentTimeMillis: Effect.succeed(at),
      })

      yield* frozen(sessions.deliverTo(first!, "first"))
      yield* frozen(sessions.deliverTo(second!, "second"))
      assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [first, second])

      yield* (yield* Bus.Service).rebuild
      assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [first, second])
    }),
  )

  test(
    "a new entry whose harness needs a first input starts at once, and the generated input waits for the slot",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const entry = yield* EntrySession.Service
      yield* limitTo(1)
      const { release } = yield* holdSlot("test/worker")
      const repo = yield* makeRepository
      yield* (yield* FakeRuntime).seedAgent("test/cursor")

      const { sessionId } = yield* entry.claim({
        directory: repo,
        projectId: yield* projectOf(repo),
        terminal: "test/cursor",
        harness: "cursor",
        runtime: "herdr",
        agent: "coordinator",
        fresh: false,
        ...unset,
      })

      assert.strictEqual(yield* db.session.workingExecutions(), 1)
      assert.isUndefined(yield* db.session.openExecution(sessionId))
      assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [sessionId])
      yield* (yield* Integration.Service).ready(sessionId, undefined)

      yield* release
      yield* until(db.session.openExecution(sessionId), (open) => open !== undefined)
    }),
  )

  test(
    "an open execution of a replaced entry does not hold a slot",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const entry = yield* EntrySession.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* limitTo(1)

      const claim = (fresh: boolean) =>
        entry.claim({
          directory: repo,
          projectId,
          terminal: "test/worker",
          harness: "pi",
          runtime: "herdr",
          agent: "coordinator",
          fresh,
          ...unset,
        })

      const { sessionId: replaced } = yield* claim(false)
      yield* (yield* FakeRuntime).seedAgent("test/worker")
      yield* (yield* Session.Service).userPrompt(replaced, "work")
      assert.strictEqual(yield* db.session.workingExecutions(), 1)

      yield* (yield* FakeRuntime).updateAgent("test/worker", (a) => ({ ...a, alive: false }))
      yield* claim(true)
      assert.strictEqual(yield* db.session.workingExecutions(), 0)
    }),
  )
})

describe("sessions that cannot take input do not hold the line", () => {
  const claimIn = (terminal: string, harness: HarnessId = PULLING_PI.id, runtime = "herdr") =>
    Effect.gen(function* () {
      const directory = yield* makeRepository
      const projectId = yield* projectOf(directory)

      const { sessionId } = yield* (yield* EntrySession.Service).claim({
        directory,
        projectId,
        terminal,
        harness,
        runtime,
        agent: "general",
        fresh: false,
        ...unset,
      })

      return { id: sessionId, directory, projectId }
    })

  const machine = Effect.gen(function* () {
    const db = yield* Db.Service
    const inbox = yield* Inbox.Service
    const runtime = yield* FakeRuntime
    yield* runtime.seedAgent("test/a")
    yield* runtime.seedAgent("test/b")
    const a = yield* claimIn("test/a")
    const b = yield* claimIn("test/b")
    yield* limitTo(1)
    yield* (yield* Session.Service).userPrompt(a.id, "hold the only slot")
    const held = (yield* db.session.openExecution(a.id))!
    const pulls = yield* Ref.make(0)
    yield* inbox.stream(b.id).pipe(
      Stream.runForEach(() =>
        Effect.andThen(
          inbox.take(b.id, undefined),
          Ref.update(pulls, (n) => n + 1),
        ),
      ),
      Effect.forkScoped,
    )
    yield* until(Ref.get(pulls), (n) => n >= 1)

    return { a, b, pulls, release: db.session.closeExecution(a.id, held, "completed") }
  })

  const bGetsTheSlot = (b: string, release: Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      yield* (yield* Session.Service).deliverTo(b, "unrelated work")
      yield* release
      yield* until(db.inbox.pendingInbox(b), (rows) => rows.length === 0)
      assert.isDefined(yield* db.session.openExecution(b))
    })

  test(
    "a child that never becomes ready",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const runtime = yield* FakeRuntime
      const { a, b, release } = yield* machine
      yield* Ref.set(runtime.onStarted, () => Effect.void)

      const { id } = yield* (yield* Session.Service).spawn({
        machine: { id: "local" },
        agent: "general",
        root: a.directory,
        parentSessionId: a.id,
        projectId: a.projectId,
        name: "queued",
        prompt: "do the original task",
        harness: PULLING_PI.id,
        runtime: "herdr",
      })

      yield* until(db.session.getSession(id), (row) => (row?.process?.placedAt ?? null) !== null)

      yield* bGetsTheSlot(b.id, release)
      assert.include(yield* db.inbox.waitingSessions(), id)
    }),
  )

  test(
    "a new Cursor entry closed before its generated first input got a slot",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const runtime = yield* FakeRuntime
      const { b, release } = yield* machine
      yield* runtime.seedAgent("test/first")
      const { id } = yield* claimIn("test/first", "cursor")
      yield* runtime.updateAgent("test/first", (agent) => ({ ...agent, alive: false }))
      yield* (yield* Session.Service).check(id)
      assert.isNotNull((yield* db.session.getSession(id))!.process!.endedAt)

      yield* bGetsTheSlot(b.id, release)
    }),
  )

  test(
    "a ready entry whose runtime became unreachable",
    Effect.gen(function* () {
      const { b, release } = yield* machine
      const other = yield* FakeRuntime.make({})
      yield* (yield* Runtimes.Service).transform((editor) => editor.add({ ...other.runtime, id: "other-runtime" }))
      yield* other.seedAgent("test/first")
      const { id } = yield* claimIn("test/first", "cursor", "other-runtime")
      yield* (yield* Integration.Service).ready(id, undefined)
      yield* (yield* Session.Service).deliverTo(id, "first in line")
      yield* Ref.set(other.reachable, false)

      yield* bGetsTheSlot(b.id, release)
    }),
  )

  test(
    "removing the limit wakes every waiting session",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const { b, pulls } = yield* machine
      yield* (yield* Session.Service).deliverTo(b.id, "work")
      yield* until(Ref.get(pulls), (n) => n >= 2)
      assert.lengthOf(yield* db.inbox.pendingInbox(b.id), 1)

      yield* (yield* Concurrency.Service).configure(undefined)
      yield* until(db.inbox.pendingInbox(b.id), (rows) => rows.length === 0)
    }),
  )

  test(
    "a follow-up to a pulling child is not taken before the child's first task",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const { a, release } = yield* machine

      const { id } = yield* sessions.spawn({
        machine: { id: "local" },
        agent: "general",
        root: a.directory,
        parentSessionId: a.id,
        projectId: a.projectId,
        name: "queued",
        prompt: "do the original task",
        harness: PULLING_PI.id,
        runtime: "herdr",
      })

      yield* until(db.session.getSession(id), (row) => (row?.process?.placedAt ?? null) !== null)
      assert.isDefined(yield* db.inbox.untakenTask(id))
      yield* sessions.send(id, "follow-up referring to the original task")

      yield* release
      const taken = yield* (yield* Inbox.Service).take(id, undefined)
      assert.isTrue(taken === undefined || (yield* db.inbox.untakenTask(id)) === undefined)
    }),
  )
})

describe("restart under a concurrency limit", () => {
  it.live("the slot a restart finds free goes to the oldest waiting message, not to the first session reconciled", () =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-concurrency-restart-")
      const runtime = yield* FakeRuntime.make({})

      const vibestd = (max: number) =>
        sessionLayer([
          PlatformNode.sqlClient.replace(SqliteClient.layer({ filename: `${home}/vibest.db`, ...SQL_NAMES })),
          runtimeNode.replace(Layer.succeed(FakeRuntime, runtime)),
          Concurrency.node.replace(
            Layer.effect(Concurrency.Service, Concurrency.make.pipe(Effect.tap((c) => c.configure([{ max }])))),
          ),
        ])

      const entry = (name: string) =>
        Effect.gen(function* () {
          const directory = `${home}/${name}`
          yield* (yield* FileSystem.FileSystem).makeDirectory(directory)
          const projectId = yield* projectOf(directory)

          const { sessionId } = yield* (yield* Db.Service).session.startEntry(
            projectId,
            "cursor",
            false,
            { runtime: RUNTIME, address: { machine: "local", id: name } },
            { agent: "general", projectDirectory: directory },
          )

          yield* runtime.seedAgent(name)
          yield* (yield* Integration.Service).ready(sessionId, undefined)

          return sessionId
        })

      const { earlier, later } = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Db.Service
          const sessions = yield* Session.Service
          const worker = yield* entry("worker")
          const later = yield* entry("later")
          const earlier = yield* entry("earlier")
          yield* sessions.userPrompt(worker, "at work")
          yield* runtime.updateAgent("worker", (a) => ({ ...a, status: "working" }))
          yield* sessions.deliverTo(earlier, "first")
          yield* sessions.deliverTo(later, "second")
          assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [earlier, later])

          return { earlier, later }
        }).pipe(Effect.provide(vibestd(1))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Db.Service
          yield* until(db.session.openExecution(earlier), (open) => open !== undefined)
          assert.isUndefined(yield* db.session.openExecution(later))
          assert.deepStrictEqual(yield* db.inbox.waitingSessions(), [later])
        }).pipe(Effect.provide(vibestd(2))),
      )
    }).pipe(Effect.scoped, Effect.provide(services)),
  )
})
