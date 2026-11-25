import { assert, describe } from "@effect/vitest"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt } from "@vibest/core/database/db-rows"
import { LIVE_PROCESS_COUNT } from "@vibest/core/database/session"
import { Drain } from "@vibest/core/drain"
import { Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { SessionLaunch } from "@vibest/core/session/entry"
import { Starts } from "@vibest/core/session/starts"
import { projectOf } from "@vibest/testkit/directory"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { settled, until, untilVirtual, writeEnd } from "@vibest/testkit/observe"
import { makeRepository, restartSessions, type TestOptions } from "@vibest/testkit/session"
import { entryOfProject, spawnInput, spawnWorking, sqlNotices, test } from "@vibest/testkit/sessions-helpers"
import { Deferred, Effect, Fiber, PubSub, Ref } from "effect"
import { SqlClient } from "effect/sql"

const limitTo = (rules: ReadonlyArray<{ readonly max: number }> | undefined) =>
  Effect.flatMap(Concurrency.Service, (c) => c.configure(rules))

const live = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ id: string }>`SELECT session_id AS id FROM process WHERE ended_at IS NULL`,
).pipe(Effect.map((rows) => rows.map((row) => row.id)))

const placed = (id: string) =>
  Effect.flatMap(Db.Service, (db) =>
    Effect.map(
      db.session.getSession(id),
      (row) => (row?.process?.placedAt ?? null) !== null && (row?.process?.endedAt ?? null) === null,
    ),
  )

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
    const entry = yield* SessionLaunch.Service

    return yield* entry.claim({
      projectId: yield* projectOf(root),
      directory: root,
      sessionId: undefined,
      harness: "pulling-pi",
      fresh,
      move: false,
      terminal: { id: terminal },
      runtime: "herdr",
      provider: undefined,
      model: undefined,
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

const parkedAdmission = () => {
  const reached = Deferred.makeUnsafe<void>()
  const go = Deferred.makeUnsafe<void>()
  const targets = new Set<string>()

  const options: TestOptions = {
    ...hooked,
    db: (db) => ({
      ...db,
      session: {
        ...db.session,
        admitProcess: (id, start, max) =>
          targets.has(id) && max === 2
            ? Effect.sync(() => targets.delete(id)).pipe(
                Effect.andThen(Deferred.succeed(reached, undefined)),
                Effect.andThen(Deferred.await(go)),
                Effect.andThen(db.session.admitProcess(id, start, max)),
              )
            : db.session.admitProcess(id, start, max),
      },
    }),
  }

  return {
    options,
    park: (id: string) =>
      Effect.sync(() => {
        targets.add(id)
      }),
    reached: Deferred.await(reached),
    release: Deferred.succeed(go, undefined).pipe(Effect.asVoid),
  }
}

const parked = parkedAdmission()
const parkedForArchive = parkedAdmission()

const exitOn = (repo: string, runtime: string) =>
  Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const sessions = yield* Session.Service
    const { id } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), runtime })
    yield* until(placed(id), (yes) => yes)
    yield* settled
    yield* writeEnd(id, "pi", { text: "status: completed" })
    yield* herdr.endExecution(id)
    yield* sessions.check(id)
    yield* settled
    yield* exit(id)
    yield* settled

    return id
  })

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
    "an entry session opens while the cap is full and counts toward it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      yield* limitTo([{ max: 1 }])
      yield* claimEntry(repo, "pane:a")
      yield* herdr.seedAgent("pane:a")
      yield* claimEntry(yield* makeRepository, "pane:other")
      assert.lengthOf(yield* live, 2)

      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === b)
      assert.lengthOf(yield* live, 2)
    }),
    hooked,
  )

  test(
    "a new entry session that replaces a stopped one takes the place of the one it replaces",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const entries = yield* SessionLaunch.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const entry = (yield* claimEntry(repo, "pane:a")).sessionId
      yield* herdr.seedAgent("pane:a")
      yield* limitTo([{ max: 1 }])
      assert.isNotNull(yield* entries.running(projectId, { id: "pane:b" }))
      yield* sessions.stop(entry, { type: "user" })
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
      const removing = yield* Effect.forkChild(sessions.archive(a!))
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

      yield* sessions.archive(b!)
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

  test(
    "a waiting run can be interrupted and another archived at once, and vibestd can stop while runs wait",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const [b, c, d] = yield* spawnSome(repo, 3)
      yield* until(waiting, (keys) => keys.length === 3)

      assert.match((yield* sessions.interrupt(b!)).message, /will not start/)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(b!))!), "not_started")
      yield* sessions.archive(c!)
      assert.deepStrictEqual(yield* waiting, [d])

      const drain = yield* Drain.Service
      assert.isTrue(yield* drain.begin)
      yield* until(drain.accept, (accepted) => accepted)
    }),
    hooked,
  )

  test(
    "a run still waiting when vibestd restarts ends not_started and its creator is told",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 1 && keys[0] === b)

      yield* restartSessions
      yield* until(db.session.getSession(b!), (row) => executionStateOf(row!) === "not_started")
      const notice = yield* db.inbox.latestInbox(b!, "notice")
      assert.include(JSON.stringify(notice), "did not start: vibestd restarted while it was waiting for a free slot")
      assert.isNull((yield* db.session.getSession(b!))!.process)
    }),
    hooked,
  )

  test(
    "the live process count reads the process_live index",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${LIVE_PROCESS_COUNT}`)
      assert.isTrue(
        plan.some((row) => row.detail.includes("process_live")),
        JSON.stringify(plan),
      )
    }),
  )
  test(
    "an interrupt racing the admission of one waiting run never drops the run behind it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      yield* spawnSome(repo, 2)
      const [a, b] = yield* until(waiting, (keys) => keys.length === 2)
      yield* parked.park(a!)

      yield* Effect.forkChild(limitTo([{ max: 2 }]))
      yield* parked.reached
      const interrupting = yield* Effect.forkChild(sessions.interrupt(a!))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      yield* parked.release
      yield* untilVirtual(
        Effect.sync(() => interrupting.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      const answer = yield* Fiber.join(interrupting)
      yield* limitTo([{ max: 3 }])
      yield* until(placed(b!), (yes) => yes)

      const launchedA = (yield* herdr.callsTo("open")).some((call) => call.env?.VIBEST_SESSION_ID === a)
      assert.isFalse(launchedA && answer.message.includes("will not start"))
    }),
    parked.options,
  )

  test(
    "a waiting relaunch whose runtime is gone frees its place for the next run",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const registry = yield* Runtimes.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      const temporary = yield* registry.transform((edit) => edit.add({ ...herdr.runtime, id: "temporary" }))
      yield* limitTo([{ max: 2 }])
      const a = yield* exitOn(repo, "temporary")
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(a, "resume")
      yield* until(waiting, (keys) => keys.includes(a))
      const [next] = yield* spawnSome(repo, 1)

      yield* temporary.dispose
      yield* limitTo([{ max: 2 }])
      yield* until(placed(next!), (yes) => yes)
      assert.isNotNull((yield* db.session.getSession(a))!.process?.endedAt ?? null)
    }),
    hooked,
  )

  test(
    "a repeated vibest run request for a waiting run answers the first session",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const input = { ...(yield* spawnInput(repo)), request: "a36df918-31cd-4593-a075-ea60d849fee0" }
      const first = yield* sessions.spawn(input)
      yield* until(waiting, (keys) => keys.includes(first.id))

      assert.strictEqual((yield* sessions.spawn(input)).id, first.id)
      assert.deepStrictEqual(yield* waiting, [first.id])
    }),
    hooked,
  )

  test(
    "the default list shows a waiting relaunch and hides an archived waiting run",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* liveEntry(repo)
      yield* limitTo([{ max: 2 }])
      const a = yield* exitedChild(repo)
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(a, "resume")
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.length === 2)
      yield* sessions.archive(b!)

      const listed = (yield* db.session.listSessions({ projectId, waiting: yield* waiting })).map((row) => row.id)
      assert.include(listed, a)
      assert.notInclude(listed, b)
    }),
    hooked,
  )
  test(
    "an archive dropped while it waits for an admission can be asked again",
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      yield* spawnSome(repo, 2)
      const [a, b] = yield* until(waiting, (keys) => keys.length === 2)
      yield* parkedForArchive.park(a!)

      yield* Effect.forkChild(limitTo([{ max: 2 }]))
      yield* parkedForArchive.reached
      const dropped = yield* Effect.forkChild(sessions.archive(b!))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      yield* Fiber.interrupt(dropped)
      yield* parkedForArchive.release

      assert.strictEqual((yield* sessions.archive(b!))?.id, b)
      assert.deepStrictEqual(yield* waiting, [])
    }),
    parkedForArchive.options,
  )

  test(
    "vibest ls shows the harness and runtime chosen for a waiting run",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      yield* limitTo([{ max: 1 }])
      const [b] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.includes(b!))
      const start = (yield* Effect.flatMap(Starts.Service, (starts) => starts.choices)).get(b!)

      assert.strictEqual(start?.harness, "pi")
      assert.strictEqual(start?.runtime, "herdr")
    }),
    hooked,
  )

  test(
    "an unclosable queued resume does not strand unrelated starts",
    Effect.gen(function* () {
      const h = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* liveEntry(repo)
      const a = yield* exitedChild(repo)
      yield* limitTo([{ max: 1 }])
      const [first] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.includes(first!))
      yield* sessions.send(a, "resume")
      yield* until(waiting, (keys) => keys.includes(a))
      const [next] = yield* spawnSome(repo, 1)
      yield* until(waiting, (keys) => keys.includes(next!))
      const opens = (yield* h.callsTo("open")).length
      const close = yield* h.hold("close", a)
      yield* Effect.forkChild(limitTo([{ max: 4 }]))
      yield* close.reached
      yield* close.release("failed")
      yield* until(placed(first!), Boolean)
      const ran = yield* until(placed(next!), Boolean).pipe(Effect.orElseSucceed(() => false))

      assert.isTrue(
        ran,
        `live=${(yield* live).length}/4, waiting=${(yield* waiting).join(",")}, expected ${next} to start`,
      )
      assert.isFalse((yield* waiting).includes(a))
      assert.strictEqual((yield* h.callsTo("open")).length, opens + 2)

      const told = yield* until(sqlNotices(a), (rows) =>
        rows.some((message) => message.includes("was not delivered") && message.includes("close: failed")),
      )

      assert.isTrue(told.some((message) => message.includes("close: failed")))

      const reason = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{
          reason: string | null
        }>`SELECT end_reason AS reason FROM process WHERE session_id = ${a} ORDER BY id DESC LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.reason),
        ),
      )

      assert.strictEqual(reason, "launch_failed")
      const kept = (yield* db.session.getSession(a))!
      assert.notStrictEqual(kept.process?.terminal ?? null, null)
      assert.notStrictEqual(kept.process?.endedAt ?? null, null)
    }),
    hooked,
  )
})
