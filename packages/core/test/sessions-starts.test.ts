import { assert, describe } from "@effect/vitest"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt } from "@vibest/core/database/db-rows"
import { Drain } from "@vibest/core/drain"
import { Session } from "@vibest/core/session"
import { EntrySession } from "@vibest/core/session/entry"
import { Starts } from "@vibest/core/session/starts"
import { Effect, Fiber, PubSub, Ref } from "effect"

import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { settled, until, writeEnd } from "./lib/observe.ts"
import { makeRepository, restartSessions } from "./lib/session.ts"
import { entryOfProject, spawnInput, spawnWorking, test } from "./lib/sessions-helpers.ts"

const limitTo = (rules: ReadonlyArray<{ readonly max: number }> | undefined) =>
  Effect.flatMap(Concurrency.Service, (c) => c.configure(rules))

const live = Effect.flatMap(Db.Service, (db) => db.session.liveProcesses())

const placed = (id: string) => Effect.map(live, (ids) => ids.includes(id))

const waiting = Effect.flatMap(Starts.Service, (starts) => starts.waiting)

const spawnSome = (repo: string, n: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const input = yield* spawnInput(repo)

    return yield* Effect.forEach(
      Array.from({ length: n }, (_, i) => i),
      (i) => Effect.map(sessions.spawn({ ...input, name: `task ${i}` }), (spawned) => spawned.id),
      { concurrency: "unbounded" },
    )
  })

const liveEntry = (repo: string) =>
  Effect.gen(function* () {
    yield* entryOfProject(repo)
    yield* (yield* FakeRuntime).seedAgent("test/coord")
  })

const exit = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* FakeRuntime).updateAgent(id, (agent) => ({ ...agent, alive: false }))
    yield* (yield* Session.Service).check(id)
  })

const claimEntry = (root: string, terminal: string, fresh = false) =>
  Effect.gen(function* () {
    const entry = yield* EntrySession.Service

    return yield* entry.claim({
      projectId: yield* projectOf(root),
      directory: root,
      harness: "pulling-pi",
      fresh,
      terminal,
      runtime: "herdr",
      provider: undefined,
      model: undefined,
      routing: undefined,
      pid: 50101,
      agent: { id: "coordinator", named: false },
    })
  })

const exitedChild = (repo: string) =>
  Effect.gen(function* () {
    const { id, sessions } = yield* spawnWorking(repo)
    yield* writeEnd(id, "pi", { text: "status: completed" })
    yield* (yield* FakeRuntime).endExecution(id)
    yield* sessions.check(id)
    yield* settled
    yield* exit(id)
    yield* settled

    return id
  })

const hooked = { hooked: ["pi", "pulling-pi", "claude"] } as const

describe("a cap on live harness processes", () => {
  test(
    "concurrent starts never pass the cap, and a waiting start launches when a process ends",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 2 }])
      const ids = yield* spawnSome(repo, 3)
      yield* until(waiting, (keys) => keys.length === 2)
      const first = yield* until(Effect.filter(ids, placed), (now) => now.length === 1)
      assert.lengthOf(yield* live, 2)

      yield* exit(first[0]!)
      yield* until(Effect.filter(ids, placed), (now) => now.length === 1 && now[0] !== first[0])
      assert.lengthOf(yield* waiting, 1)
      assert.lengthOf(yield* live, 2)
    }),
    hooked,
  )

  test(
    "raising or removing the limit launches the waiting starts",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const ids = yield* spawnSome(repo, 3)
      yield* until(waiting, (keys) => keys.length === 3)

      yield* limitTo([{ max: 2 }])
      yield* until(Effect.filter(ids, placed), (now) => now.length === 1)
      assert.lengthOf(yield* waiting, 2)

      yield* limitTo(undefined)
      yield* until(Effect.filter(ids, placed), (now) => now.length === 3)
      assert.lengthOf(yield* waiting, 0)
    }),
    hooked,
  )

  test(
    "a start that never becomes ready holds only its own place, and a failed start frees its place",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 3 }])
      yield* Ref.set(herdr.onStarted, () => Effect.void)
      const [never] = yield* spawnSome(repo, 1)
      yield* until(placed(never!), (yes) => yes)

      const opening = yield* herdr.hold("open")
      const { id: failing } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), name: "failing" })
      yield* opening.reached
      const [next] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === next)

      yield* opening.release("failed")
      yield* until(db.session.getSession(failing), (row) => row !== undefined && exitedAt(row) !== null)
      yield* until(placed(next!), (yes) => yes)
    }),
    hooked,
  )

  test(
    "a running session takes sends while the cap is full",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(id, "while full")
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* until(db.inbox.pendingInbox(id), (rows) => rows.length === 0)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "while full")
    }),
    hooked,
  )

  test(
    "reopening an exited entry session waits like any other start",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const entry = (yield* claimEntry(repo, "pane:a")).sessionId
      yield* herdr.seedAgent("pane:a")
      yield* limitTo([{ max: 1 }])
      yield* herdr.updateAgent("pane:a", (agent) => ({ ...agent, alive: false }))
      yield* sessions.check(entry)
      yield* until(live, (ids) => ids.length === 0)

      const other = yield* makeRepository
      yield* claimEntry(other, "pane:other")
      yield* until(live, (ids) => ids.length === 1)
      const reopening = yield* Effect.forkChild(claimEntry(repo, "pane:b"))
      yield* until(waiting, (keys) => keys.length === 1)
      assert.lengthOf(yield* live, 1)

      yield* limitTo(undefined)
      yield* Fiber.join(reopening)
      assert.lengthOf(yield* live, 2)
    }),
    hooked,
  )

  test(
    "a new entry session that replaces a stopped one takes the place of the one it replaces",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const entries = yield* EntrySession.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const entry = (yield* claimEntry(repo, "pane:a")).sessionId
      yield* herdr.seedAgent("pane:a")
      yield* limitTo([{ max: 1 }])
      const running = (yield* entries.running(projectId, "pane:b"))!
      assert.strictEqual((yield* entries.stop(projectId, running.runtime, running.address)).result, "stopped")
      yield* herdr.updateAgent("pane:a", (agent) => ({ ...agent, alive: false }))
      yield* sessions.check(entry)

      const replacement = yield* claimEntry(repo, "pane:b", true)
      assert.deepStrictEqual(yield* live, [replacement.sessionId])
      assert.deepStrictEqual(yield* waiting, [])
    }),
    hooked,
  )

  test(
    "an archived session whose terminal did not close still counts until its process ends",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 2 }])
      const [a] = yield* spawnSome(repo, 1)
      yield* until(placed(a!), (yes) => yes)
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === b)

      const closing = yield* herdr.hold("close", a!)
      const removing = yield* Effect.forkChild(sessions.remove(a!))
      yield* closing.reached
      yield* closing.release("failed")
      assert.strictEqual((yield* Fiber.join(removing))?.pane, "kept")
      assert.deepStrictEqual(yield* waiting, [b])
      assert.isFalse(yield* placed(b!))
    }),
    hooked,
  )

  test(
    "a runtime reset leaves a waiting run waiting",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === b)
      const before = (yield* sessions.inMemory).reconciles
      yield* PubSub.publish(herdr.events, { type: "reset" })
      yield* until(sessions.inMemory, (m) => m.reconciles > before)

      assert.deepStrictEqual(yield* waiting, [b])
      assert.isNull((yield* db.session.getSession(b!))!.process?.endedAt ?? null)
      assert.isUndefined(yield* db.inbox.latestInbox(b!, "notice"))
    }),
    hooked,
  )

  test(
    "archiving a waiting run takes it out of the queue and leaves nothing for vibestd to wait on",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === b)

      yield* sessions.remove(b!)
      assert.deepStrictEqual(yield* waiting, [])

      const drain = yield* Drain.Service
      assert.isTrue(yield* drain.begin)
      yield* until(drain.accept, (accepted) => accepted)
    }),
    hooked,
  )

  test(
    "two sends to an exited session while the cap is full relaunch it once and leave nothing waiting",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* claimEntry(repo, "pane:a")
      yield* (yield* FakeRuntime).seedAgent("pane:a")
      yield* limitTo([{ max: 2 }])
      const a = yield* exitedChild(repo)
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(a, "first")
      yield* until(waiting, (keys) => keys.includes(a))
      yield* sessions.send(a, "second")

      yield* limitTo([{ max: 2 }])
      yield* until(placed(a), (yes) => yes)
      yield* settled
      assert.deepStrictEqual(yield* waiting, [])
      assert.lengthOf(yield* live, 2)
    }),
    hooked,
  )

  test(
    "a send waiting for a slot when vibestd stops is delivered after the restart",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* limitTo([{ max: 2 }])
      const a = yield* exitedChild(repo)
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(a, "first")
      yield* until(waiting, (keys) => keys.includes(a))

      const fresh = yield* restartSessions
      yield* until(fresh.inMemory, (m) => m.reconciles >= 1)
      yield* until(placed(a), (yes) => yes)
      yield* until(db.inbox.pendingInbox(a), (rows) => rows.length === 0)
    }),
    hooked,
  )
})
