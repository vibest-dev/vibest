import { assert, describe, it } from "@effect/vitest"
import { writeClaimFile } from "@vibest/core/claude-inbox"
import { Db, type SessionRow } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { registry, Runtimes } from "@vibest/core/runtimes"
import { repositoryKey } from "@vibest/core/worktree"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Ref, Stream } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { FakeRuntime, makeRepository, tempDirectory, testLayer } from "./fakes.ts"

const test = (name: string, program: () => Effect.Effect<void, any, any>) =>
  it.effect(name, () => program().pipe(Effect.provide(testLayer())))
const session = (id: string): Omit<SessionRow, "projectId"> => ({
  id,
  agent: "general",
  name: "n",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "default" },
  status: "idle",
  startedAt: 1,
  exitedAt: null,
  turnState: "none",
  turnPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
})
const pane = "w1:p1"
const claudeId = "claude-session-1"
type Mutable = Record<string, unknown>
/** Park inside a Db method after it has returned, so interrupt lands after that method and before the caller continues. The 0ac74b2 B4 probe timed out once at 5s; this barrier does not sleep. */
const parkAfter = <A>(db: object, method: string, f: Effect.Effect<A, any, any>) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const never = yield* Deferred.make<void>()
    const original = (db as Mutable)[method] as (...args: Array<unknown>) => Effect.Effect<unknown>
    ;(db as Mutable)[method] = (...args: Array<unknown>) =>
      original(...args).pipe(
        Effect.tap(() => Deferred.succeed(reached, undefined)),
        Effect.andThen(Deferred.await(never)),
      )
    const fiber = yield* Effect.forkChild(f)
    yield* Deferred.await(reached)
    ;(db as Mutable)[method] = original
    yield* Fiber.interrupt(fiber)
  })

const ready = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const herdr = yield* FakeRuntime
  const key = yield* repositoryKey(yield* makeRepository)
  const coord = yield* db.coordinatorLaunch(key, "claude", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: pane },
  })
  yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
  yield* herdr.seedAgent(pane)
  assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), key))
  const projectId = yield* db.projectId(key)
  const call = { projectId, terminal: pane, claudeSessionId: claudeId }
  const sql = yield* SqlClient.SqlClient
  const status = (message: string) =>
    sql<{
      status: string
    }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE i.content = ${message} OR m.output = ${message}`.pipe(
      Effect.map((rows) => rows[0]?.status),
    )
  const add = (message: string) =>
    db.insertInbox({ sessionId: "aaaaaaaa", kind: "result" as const, message, details: {} })
  return { db, inbox, key, coord, projectId, call, status, add }
})

describe("Claude inbox protocol regressions", () => {
  test("a pull interrupted after claim does not leave an ownerless sending row", () =>
    Effect.gen(function* () {
      const { db, inbox, call, projectId, status, add } = yield* ready
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      yield* add("one")
      yield* parkAfter(db, "claim", inbox.pull({ ...call, generation }))
      assert.notStrictEqual(yield* status("one"), "delivering")
      const next = yield* inbox.pull({ ...call, generation })
      assert.isString(next.token)
      yield* inbox.reconcile(projectId)
    }))

  it.effect("a failed claim rename removes only that write's temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "inbox-claims-" })
      const target = path.join(dir, "claim")
      yield* fs.makeDirectory(target)
      yield* fs.writeFileString(path.join(dir, "keep.txt"), "leave")
      const exit = yield* Effect.exit(writeClaimFile(fs, path, target, "body", "owned"))
      assert.isTrue(Exit.isFailure(exit))
      const names = yield* fs.readDirectory(dir)
      assert.deepStrictEqual(
        names.filter((name) => name.endsWith(".tmp")),
        [],
      )
      assert.strictEqual(yield* fs.readFileString(path.join(dir, "keep.txt")), "leave")
    }).pipe(Effect.provide(Platform.services)),
  )

  test("release-retry interrupted after commit does not offer the old token", () =>
    Effect.gen(function* () {
      const { db, inbox, call, status, add } = yield* ready
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      yield* add("three")
      const first = yield* inbox.pull({ ...call, generation })
      yield* parkAfter(
        db,
        "withCoordinatorWrite",
        inbox.release({ ...call, generation, token: first.token!, retry: true }),
      )
      assert.strictEqual(yield* status("three"), "pending")
      const again = yield* inbox.pull({ ...call, generation })
      assert.notStrictEqual(again.token, first.token)
      const acked = yield* inbox.ack({ ...call, generation, token: first.token! })
      assert.notStrictEqual(acked.acked, true)
    }))

  test("ack interrupted after commit does not let a later release report success", () =>
    Effect.gen(function* () {
      const { db, inbox, call, status, add } = yield* ready
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      yield* add("four")
      const first = yield* inbox.pull({ ...call, generation })
      yield* parkAfter(db, "withCoordinatorWrite", inbox.ack({ ...call, generation, token: first.token! }))
      const released = yield* inbox.release({ ...call, generation, token: first.token!, retry: false })
      assert.strictEqual(yield* status("four"), "delivered")
      assert.notStrictEqual(released.released, true)
    }))

  test("replace interrupted after commit does not keep the old generation live", () =>
    Effect.gen(function* () {
      const { db, inbox, call, projectId, status, add } = yield* ready
      const old = (yield* inbox.attach({ ...call, replace: false })).generation!
      yield* add("five")
      const claim = yield* inbox.pull({ ...call, generation: old })
      yield* parkAfter(db, "withCoordinatorWrite", inbox.attach({ ...call, replace: true }))
      const marker = (yield* db.readCoordinatorFence(projectId))!.bridge!.generation
      assert.notStrictEqual(marker, old)
      const oldPull = yield* inbox.pull({ ...call, generation: old })
      assert.strictEqual(oldPull.error, "stale-receiver")
      const oldAck = yield* inbox.ack({ ...call, generation: old, token: claim.token! })
      assert.notStrictEqual(oldAck.acked, true)
      assert.strictEqual(yield* status("five"), "failed")
    }))

  test("a registered Pi subscriber keeps its original pane and does not take the next one", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const inbox = yield* Inbox
      const key = yield* repositoryKey(yield* makeRepository)
      yield* db.coordinatorLaunch(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "wA:pA" } })
      assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), key))
      const projectId = yield* db.projectId(key)
      const got = yield* Ref.make<Array<string>>([])
      const first = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        inbox
          .stream(projectId)
          .pipe(
            Stream.runForEach((batch) =>
              Ref.update(got, (seen) => [...seen, batch]).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
            ),
          ),
      )
      yield* inbox.enqueue({ sessionId: "aaaaaaaa", kind: "result", message: "for-A", details: {} })
      yield* Deferred.await(first)
      yield* db.coordinatorLaunch(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "wB:pB" } })
      yield* inbox.enqueue({ sessionId: "aaaaaaaa", kind: "result", message: "for-B", details: {} })
      yield* Effect.yieldNow
      yield* inbox.reconcile(projectId)
      const seen = yield* Ref.get(got)
      const sql = yield* SqlClient.SqlClient
      const row = yield* sql<{
        status: string
      }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'for-B'`
      assert.notStrictEqual(row[0]?.status, "delivering")
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(seen, ["for-A"])
    }))

  test("a registered Pi subscriber does not claim rows after the coordinator becomes Claude", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const inbox = yield* Inbox
      const herdr = yield* FakeRuntime
      const key = yield* repositoryKey(yield* makeRepository)
      const coord = yield* db.coordinatorLaunch(key, "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: pane },
      })
      assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), key))
      const projectId = yield* db.projectId(key)
      const got = yield* Ref.make<Array<string>>([])
      const first = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        inbox
          .stream(projectId)
          .pipe(
            Stream.runForEach((batch) =>
              Ref.update(got, (seen) => [...seen, batch]).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
            ),
          ),
      )
      yield* inbox.enqueue({ sessionId: "aaaaaaaa", kind: "result", message: "pi-1", details: {} })
      yield* Deferred.await(first)
      yield* db.coordinatorLaunch(key, "claude", false, { runtime: RUNTIME, address: { machine: "local", id: pane } })
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
      yield* herdr.seedAgent(pane)
      const generation = (yield* inbox.attach({ projectId, terminal: pane, claudeSessionId: claudeId, replace: false }))
        .generation!
      yield* inbox.enqueue({ sessionId: "aaaaaaaa", kind: "result", message: "claude-1", details: {} })
      yield* inbox.reconcile(projectId)
      const native = yield* inbox.pull({ projectId, terminal: pane, claudeSessionId: claudeId, generation })
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(yield* Ref.get(got), ["pi-1"])
      assert.strictEqual(yield* (yield* FileSystem.FileSystem).readFileString(native.file!), "claude-1")
    }))

  test("a new Claude session cannot pull the previous session's generation", () =>
    Effect.gen(function* () {
      const { db, inbox, call, coord, status, add } = yield* ready
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", "claude-session-2")
      yield* add("nine")
      const pulled = yield* inbox.pull({ ...call, claudeSessionId: "claude-session-2", generation })
      assert.isUndefined(pulled.token)
      assert.strictEqual(pulled.error, "stale-receiver")
      assert.strictEqual(yield* status("nine"), "pending")
    }))

  it.effect("reopening the database and inbox does not revive a generation or delete unknown files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("inbox-restart-")
      const dbFile = path.join(home, "vibest.db")
      const stack = Inbox.layer.pipe(
        Layer.provideMerge(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(dbFile)))),
        Layer.provideMerge(
          Layer.effect(
            Runtimes,
            Effect.flatMap(FakeRuntime, (fake) => registry([fake.runtime])),
          ),
        ),
        Layer.provideMerge(FakeRuntime.layer()),
        Layer.provideMerge(Layer.effect(Layout, Layout.make(home))),
        Layer.provideMerge(builtinHarnesses),
        Layer.provideMerge(Drain.layer),
        Layer.provideMerge(Platform.services),
      )
      const open = <A>(program: Effect.Effect<A, any, any>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(stack)
            return yield* program.pipe(Effect.provide(context))
          }),
        )
      const generation = yield* open(
        Effect.gen(function* () {
          const db = yield* Db
          const inbox = yield* Inbox
          const herdr = yield* FakeRuntime
          const key = yield* repositoryKey(yield* makeRepository)
          const coord = yield* db.coordinatorLaunch(key, "claude", false, {
            runtime: RUNTIME,
            address: { machine: "local", id: pane },
          })
          yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
          yield* herdr.seedAgent(pane)
          assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), key))
          const projectId = yield* db.projectId(key)
          const call = { projectId, terminal: pane, claudeSessionId: claudeId }
          const attached = yield* inbox.attach({ ...call, replace: false })
          yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "body", details: {} })
          const pulled = yield* inbox.pull({ ...call, generation: attached.generation! })
          assert.isString(pulled.token)
          yield* fs.writeFileString(path.join(home, "inbox-claims", "keep.txt"), "leave")
          return attached.generation!
        }),
      )
      yield* open(
        Effect.gen(function* () {
          const db = yield* Db
          const inbox = yield* Inbox
          const herdr = yield* FakeRuntime
          const projectId = (yield* db.coordinators)[0]!.projectId
          yield* herdr.seedAgent(pane)
          const call = { projectId, terminal: pane, claudeSessionId: claudeId }
          const pulled = yield* inbox.pull({ ...call, generation })
          assert.strictEqual(pulled.error, "stale-receiver")
          yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "later", details: {} })
          yield* inbox.deliver(projectId)
          assert.strictEqual((yield* herdr.callsTo("send")).length, 0)
          assert.strictEqual(yield* fs.readFileString(path.join(home, "inbox-claims", "keep.txt")), "leave")
          const sql = yield* SqlClient.SqlClient
          const body = yield* sql<{
            status: string
          }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'body'`
          const later = yield* sql<{
            status: string
          }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'later'`
          assert.strictEqual(body[0]?.status, "failed")
          assert.strictEqual(later[0]?.status, "pending")
        }),
      )
    }).pipe(Effect.provide(Platform.services)),
  )
})
