import { assert, describe, it } from "@effect/vitest"
import { Db, type SessionRow } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { repositoryKey } from "@vibest/core/worktree"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Deferred, Effect, Exit, Fiber, FileSystem, Path } from "effect"
import { SqlClient } from "effect/sql"

import { FakeRuntime, makeRepository, testLayer } from "./fakes.ts"

const session = "aaaaaaaa"
const pane = "w1:p1"
const claude = "claude-session-1"
const test = (name: string, program: () => Effect.Effect<void, any, any>) =>
  it.effect(name, () => program().pipe(Effect.provide(testLayer())))

const worker = (id: string): Omit<SessionRow, "projectId"> => ({
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

const open = Effect.gen(function* () {
  const db = yield* Db
  const sql = yield* SqlClient.SqlClient
  const inbox = yield* Inbox
  const layout = yield* Layout
  const herdr = yield* FakeRuntime
  const key = yield* repositoryKey(yield* makeRepository)
  const coord = yield* db.coordinatorLaunch(key, "claude", false, {
    runtime: RUNTIME,
    address: { machine: "local", id: pane },
  })
  yield* db.reportCoordinatorSession(coord.sessionId, "claude", claude)
  yield* herdr.seedAgent(pane)
  assert.isTrue(yield* db.insertSession(worker(session), key))
  const projectId = yield* db.projectId(key)
  const call = { projectId, terminal: pane, claudeSessionId: claude }
  const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
  const status = (message: string) =>
    sql<{
      status: string
    }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE i.content = ${message} OR m.output = ${message}`.pipe(
      Effect.map((rows) => rows[0]?.status),
    )
  const add = (message: string) => db.insertInbox({ sessionId: session, kind: "result" as const, message, details: {} })
  yield* add("report one")
  return { db, sql, inbox, layout, call, generation, status, add }
})

const parkAfter = (db: object, method: "withCoordinatorWrite" | "transitionInbox", effect: Effect.Effect<unknown>) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const original = (db as Record<string, (...args: Array<unknown>) => Effect.Effect<unknown>>)[method]!
    ;(db as Record<string, unknown>)[method] = (...args: Array<unknown>) =>
      original(...args).pipe(
        Effect.tap(() => Deferred.succeed(reached, undefined)),
        Effect.andThen(Effect.never),
      )
    const fiber = yield* Effect.forkChild(effect)
    yield* Deferred.await(reached)
    ;(db as unknown as Record<string, unknown>)[method] = original
    yield* Fiber.interrupt(fiber)
  })

/** Park inside the transaction connection immediately after SQLite executes COMMIT, then optionally record a pending interrupt. */
const duringCommit = <A, E>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, any>, interrupt: boolean) =>
  Effect.gen(function* () {
    const found = yield* sql.withTransaction(Effect.serviceOption(sql.transactionService))
    const conn = (found as any).value[0] as {
      executeUnprepared: (this: unknown, ...args: Array<unknown>) => Effect.Effect<unknown>
    }
    const original = conn.executeUnprepared
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let armed = true
    let committed = false
    conn.executeUnprepared = function (this: unknown, ...args: Array<unknown>) {
      const run = original.apply(this, args)
      if (!armed || args[0] !== "COMMIT") return run
      armed = false
      return run.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            committed = true
          }),
        ),
        Effect.tap(() => Deferred.succeed(reached, undefined)),
        Effect.tap(() => Deferred.await(release)),
      )
    }
    const fiber = yield* Effect.forkChild(effect)
    yield* Deferred.await(reached)
    conn.executeUnprepared = original
    if (interrupt) yield* Effect.sync(() => fiber.interruptUnsafe())
    yield* Deferred.succeed(release, undefined)
    const exit = yield* Fiber.await(fiber)
    return { exit, committed }
  })

const breakForeignKey = (sql: SqlClient.SqlClient, message: string) =>
  sql
    .unsafe("PRAGMA defer_foreign_keys = ON")
    .pipe(
      Effect.andThen(
        sql.unsafe(
          "UPDATE inbox SET recipient_session_id = 'zzzzzzzz' WHERE result_message_id = (SELECT id FROM message WHERE output = '" +
            message +
            "')",
        ),
      ),
    )

describe("Claude inbox commit boundary", () => {
  test("does not expose a claim when publication is cancelled before the file exists", () =>
    open.pipe(
      Effect.flatMap(({ db, inbox, layout, call, generation, status }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* parkAfter(db, "withCoordinatorWrite", inbox.pull({ ...call, generation }))
          const next = yield* inbox.pull({ ...call, generation })
          const exists = next.token === undefined ? false : yield* fs.exists(layout.inboxClaim(generation, next.token!))
          if (next.token === undefined) assert.notStrictEqual(yield* status("report one"), "delivering")
          else assert.isTrue(exists)
        }),
      ),
    ))

  test("an interrupted rename leaves no claim file and restores the row", () =>
    open.pipe(
      Effect.flatMap(({ inbox, layout, call, generation, status }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const target = fs as unknown as {
            rename: (oldPath: string, newPath: string) => Effect.Effect<void, any, any>
          }
          const original = target.rename.bind(fs)
          target.rename = (oldPath, newPath) =>
            original(oldPath, newPath).pipe(
              Effect.tap(() => Deferred.succeed(reached, undefined)),
              Effect.andThen(Deferred.await(release)),
            )
          const claims = (yield* Path.Path).dirname(layout.inboxClaim(generation, "token"))
          yield* fs.makeDirectory(claims, { recursive: true })
          yield* fs.writeFileString(claims + "/unknown.txt", "keep")
          const fiber = yield* Effect.forkChild(inbox.pull({ ...call, generation }))
          yield* Deferred.await(reached)
          target.rename = original
          yield* Fiber.interrupt(fiber)
          yield* Deferred.succeed(release, undefined)
          assert.deepStrictEqual((yield* fs.readDirectory(claims)).sort(), ["unknown.txt"])
          assert.strictEqual(yield* status("report one"), "pending")
        }),
      ),
    ))

  test("a failed commit does not record an ack receipt", () =>
    open.pipe(
      Effect.flatMap(({ db, sql, inbox, call, generation, status, add }) =>
        Effect.gen(function* () {
          const first = yield* inbox.pull({ ...call, generation })
          yield* add("victim")
          const original = db.transitionInbox.bind(db)
          db.transitionInbox = ((...args: Parameters<typeof db.transitionInbox>) =>
            original(...args).pipe(Effect.tap(() => breakForeignKey(sql, "victim")))) as typeof db.transitionInbox
          const failed = yield* Effect.exit(inbox.ack({ ...call, generation, token: first.token! }))
          db.transitionInbox = original
          assert.isFalse(Exit.isSuccess(failed))
          assert.strictEqual(yield* status("report one"), "delivering")
          const retry = yield* inbox.ack({ ...call, generation, token: first.token! })
          assert.notDeepEqual(retry, { acked: true, already: true })
          assert.deepStrictEqual(retry, { acked: true })
        }),
      ),
    ))

  test("a failed commit keeps the previous attachment", () =>
    open.pipe(
      Effect.flatMap(({ db, sql, inbox, call, generation, status }) =>
        Effect.gen(function* () {
          const first = yield* inbox.pull({ ...call, generation })
          const original = db.writeCoordinatorBridge.bind(db)
          db.writeCoordinatorBridge = ((...args: Parameters<typeof db.writeCoordinatorBridge>) =>
            original(...args).pipe(
              Effect.tap(() => breakForeignKey(sql, "report one")),
            )) as typeof db.writeCoordinatorBridge
          const failed = yield* Effect.exit(inbox.attach({ ...call, replace: true }))
          db.writeCoordinatorBridge = original
          assert.isFalse(Exit.isSuccess(failed))
          const again = yield* inbox.pull({ ...call, generation })
          assert.strictEqual(again.token, first.token)
          const replaced = yield* inbox.attach({ ...call, replace: true })
          assert.ok(replaced.generation)
          assert.notStrictEqual(yield* status("report one"), "delivering")
        }),
      ),
    ))

  test("C1 an interrupt pending during COMMIT does not leave a sending row with no owner", () =>
    open.pipe(
      Effect.flatMap(({ inbox, call, generation, sql, status }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { exit, committed } = yield* duringCommit(sql, inbox.pull({ ...call, generation }), true)
          const row = yield* status("report one")
          const next = yield* inbox.pull({ ...call, generation })
          const exists = next.file === undefined ? false : yield* fs.exists(next.file)
          assert.isTrue(committed)
          assert.isTrue(Exit.isFailure(exit))
          assert.strictEqual(row, "pending")
          assert.ok(next.token)
          assert.isTrue(exists)
        }),
      ),
    ))

  test("C2 an interrupt pending during replace COMMIT keeps the new generation and deletes the old claim file", () =>
    open.pipe(
      Effect.flatMap(({ db, inbox, call, generation, layout, sql, status }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const first = yield* inbox.pull({ ...call, generation })
          const oldName = first.file!.split("/").pop()!
          const { committed } = yield* duringCommit(sql, inbox.attach({ ...call, replace: true }), true)
          const fence = yield* db.readCoordinatorFence(call.projectId)
          const again = yield* Effect.exit(inbox.attach({ ...call, replace: true }))
          const names = yield* fs.readDirectory((yield* Path.Path).dirname(layout.inboxClaim(generation, "x")))
          assert.isTrue(committed)
          assert.strictEqual(fence?.bridge?.generation === generation, false)
          assert.isTrue(Exit.isSuccess(again))
          assert.isFalse(names.includes(oldName))
          assert.notStrictEqual(yield* status("report one"), "delivering")
        }),
      ),
    ))

  test("C3 an interrupt pending during ack COMMIT keeps the receipt and deletes the claim file", () =>
    open.pipe(
      Effect.flatMap(({ inbox, call, generation, layout, sql }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const first = yield* inbox.pull({ ...call, generation })
          const name = first.file!.split("/").pop()!
          const { committed } = yield* duringCommit(sql, inbox.ack({ ...call, generation, token: first.token! }), true)
          const retry = yield* inbox.ack({ ...call, generation, token: first.token! })
          const names = yield* fs.readDirectory((yield* Path.Path).dirname(layout.inboxClaim(generation, "x")))
          assert.isTrue(committed)
          assert.deepStrictEqual(retry, { acked: true, already: true })
          assert.isFalse(names.includes(name))
        }),
      ),
    ))

  test("E1 a permission error on the published claim file is reported, not treated as absence", () =>
    open.pipe(
      Effect.flatMap(({ inbox, call, generation, layout, status }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const claims = path.dirname(layout.inboxClaim(generation, "x"))
          const calls: Array<string> = []
          const record = <A>(what: string, effect: Effect.Effect<A, any, any>) =>
            effect.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  const tag = Exit.isSuccess(exit)
                    ? "ok"
                    : String((exit.cause as any).reasons?.[0]?.error?.reason?._tag ?? "fail")
                  calls.push(what + ":" + tag)
                }),
              ),
            )
          const real = { exists: fs.exists.bind(fs), remove: fs.remove.bind(fs), rename: fs.rename.bind(fs) }
          const target = fs as unknown as {
            exists: (p: string) => Effect.Effect<boolean, any, any>
            remove: (p: string) => Effect.Effect<void, any, any>
            rename: (a: string, b: string) => Effect.Effect<void, any, any>
          }
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          target.exists = (p) => record("exists " + p.split("/").pop(), real.exists(p))
          target.remove = (p) => record("remove " + p.split("/").pop(), real.remove(p))
          target.rename = (a, b) =>
            real.rename(a, b).pipe(
              Effect.tap(() => Deferred.succeed(reached, undefined)),
              Effect.andThen(Deferred.await(release)),
            )
          const fiber = yield* Effect.forkChild(inbox.pull({ ...call, generation }))
          yield* Deferred.await(reached)
          target.rename = real.rename
          yield* fs.chmod(claims, 0o000)
          yield* Effect.exit(Fiber.interrupt(fiber)).pipe(Effect.ensuring(Effect.orDie(fs.chmod(claims, 0o755))))
          yield* Deferred.succeed(release, undefined)
          const left = (yield* fs.readDirectory(claims)).filter((name) => !name.endsWith(".tmp"))
          assert.strictEqual(yield* status("report one"), "pending")
          assert.strictEqual(left.length, 1)
          assert.isTrue(
            calls.some(
              (entry) =>
                entry.slice("remove ".length, entry.lastIndexOf(":")) === left[0] &&
                entry.endsWith(":PermissionDenied"),
            ),
          )
        }),
      ),
    ))

  test("interrupting settlement does not publish a receipt", () =>
    open.pipe(
      Effect.flatMap(({ db, inbox, call, generation, status }) =>
        Effect.gen(function* () {
          const first = yield* inbox.pull({ ...call, generation })
          yield* parkAfter(db, "transitionInbox", inbox.ack({ ...call, generation, token: first.token! }))
          assert.strictEqual(yield* status("report one"), "delivering")
          assert.deepStrictEqual(yield* inbox.ack({ ...call, generation, token: first.token! }), { acked: true })
          assert.strictEqual(yield* status("report one"), "delivered")
        }),
      ),
    ))
})
