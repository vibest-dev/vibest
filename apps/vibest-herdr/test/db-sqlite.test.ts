import fs from "node:fs/promises"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db, SQL_NAMES } from "@vibest/core/db"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { projectOf, tempDirectory } from "./fakes.ts"

const database = (filename: string) =>
  Db.layer.pipe(Layer.provideMerge(Platform.sqlite(filename)), Layer.provide(Bus.layer))

const modeOf = (path: string) => Effect.promise(async () => (await fs.stat(path)).mode & 0o777)

const modes = (file: string) =>
  Effect.gen(function* () {
    return { db: yield* modeOf(file), wal: yield* modeOf(`${file}-wal`), shm: yield* modeOf(`${file}-shm`) }
  })

const SQLITE_SYNCHRONOUS_NORMAL = 1

describe("SQLite", () => {
  it.effect("a writable database is WAL with synchronous NORMAL", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-sync-")}/vibest.db`
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ journalMode: string }>`PRAGMA journal_mode`)[0]?.journalMode, "wal")
        assert.strictEqual(
          (yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous,
          SQLITE_SYNCHRONOUS_NORMAL,
        )
      }).pipe(Effect.provide(database(file)))
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("vibest.db and its wal and shm are mode 0600, including files that were looser", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-mode-")}/vibest.db`
      const modesWhileOpen = modes(file).pipe(Effect.provide(database(file)))
      assert.deepStrictEqual(yield* modesWhileOpen, { db: 0o600, wal: 0o600, shm: 0o600 })
      yield* Effect.gen(function* () {
        const heldOpenSoSqliteNeitherDeletesNorRecreatesWal = Context.get(
          yield* Layer.build(SqliteClient.layer({ filename: file, ...SQL_NAMES })),
          SqlClient.SqlClient,
        )
        yield* heldOpenSoSqliteNeitherDeletesNorRecreatesWal`SELECT count(*) AS n FROM sqlite_master`
        yield* Effect.promise(() =>
          Promise.all([file, `${file}-wal`, `${file}-shm`].map((path) => fs.chmod(path, 0o644))),
        )
        assert.deepStrictEqual(yield* modesWhileOpen, { db: 0o600, wal: 0o600, shm: 0o600 })
      }).pipe(Effect.scoped)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a writable transaction is BEGIN IMMEDIATE and busy_timeout is 5000", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-sqlite-lock-")
      const pragmaFile = `${dir}/pragma.db`
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]?.timeout, 5000)
      }).pipe(Effect.provide(Platform.sqlite(pragmaFile)))

      const file = `${dir}/lock.db`
      const vibestsOwnConnection = Context.get(yield* Layer.build(Platform.sqlite(file)), SqlClient.SqlClient)
      const writerThatTimesOutFast = Context.get(
        yield* Layer.build(SqliteClient.layer({ filename: file, busyTimeout: "50 millis", ...SQL_NAMES })),
        SqlClient.SqlClient,
      )
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const holder = yield* vibestsOwnConnection
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      assert.strictEqual((yield* writerThatTimesOutFast<{ n: number }>`SELECT 1 AS n`)[0]?.n, 1)
      const exit = yield* writerThatTimesOutFast
        .withTransaction(writerThatTimesOutFast`SELECT 1 AS n`)
        .pipe(Effect.exit)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(holder)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit))
        assert.strictEqual(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.reason._tag, "LockTimeoutError")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.live("interrupting a fiber queued for a transaction does not leak the write permit", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-interrupt-")}/vibest.db`
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const starters = [["withTransaction", () => sql.withTransaction(Effect.never)]] as const
        for (const [label, start] of starters) {
          for (let offset = 0; offset <= 30; offset++) {
            const gate = yield* Deferred.make<void>()
            const holding = yield* Deferred.make<void>()
            const holder = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* Deferred.succeed(holding, undefined)
                  yield* Deferred.await(gate)
                }),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(holding)
            const waiter = yield* start().pipe(Effect.forkChild)
            for (let step = 0; step < offset; step++) yield* Effect.yieldNow
            yield* Effect.all(
              [Fiber.interrupt(waiter), Deferred.succeed(gate, undefined).pipe(Effect.andThen(Fiber.join(holder)))],
              { concurrency: "unbounded" },
            )
            yield* sql`SELECT 1`.pipe(
              Effect.timeout("1 second"),
              Effect.catchTag("TimeoutError", () =>
                Effect.die(`write permit leaked at ${label} yield offset ${offset}`),
              ),
            )
          }
        }
      }).pipe(Effect.provide(database(file)))
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("two creates of one never-seen directory are the same project", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-project-")}/vibest.db`
      const open = database(file)
      const createFileBeforeConcurrentOpens = Effect.void.pipe(Effect.provide(open))
      yield* createFileBeforeConcurrentOpens
      const dir = `${file}-repo`
      const create = Effect.gen(function* () {
        return yield* (yield* Db).createProject(dir, [{ path: `${dir}/app`, remote: "git@example.com:a.git" }])
      }).pipe(Effect.provide(open))
      const [a, b] = yield* Effect.all([create, create], { concurrency: 2 })
      assert.strictEqual(a, b)
      assert.strictEqual(yield* create, a)
      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ id: string; path: string }>`SELECT p.id, r.path FROM project p
          LEFT JOIN project_repository r ON r.project_id = p.id WHERE p.directory = ${dir}`
      }).pipe(Effect.provide(open))
      assert.deepStrictEqual(rows, [{ id: a, path: `${dir}/app` }])
    }).pipe(Effect.provide(Platform.services)),
  )
})

describe("a vibestd restart", () => {
  it.effect("rows cut off in delivery to a polling main agent go back to pending; any other main agent's failed", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-recover-")}/vibest.db`
      const ids = yield* Effect.gen(function* () {
        const db = yield* Db
        const place = (id: string) => ({ runtime: "fake", address: { machine: "local", id } })
        const ids: Array<number> = []
        for (const [key, harness] of [
          ["a", "claude"],
          ["b", "pi"],
        ] as const) {
          const { sessionId } = yield* db.coordinatorLaunch(yield* projectOf(key), harness, false, place(key))
          const row = yield* db.insertInbox({ sessionId, kind: "notice", message: key, details: {} })
          assert.deepStrictEqual(yield* db.claim([row.id]), [row.id])
          ids.push(row.id)
        }
        return ids
      }).pipe(Effect.provide(database(file)))
      const statuses = yield* Effect.gen(function* () {
        const harnessesWhoseAdapterPollsAsInboxLayerPasses = ["claude"] as const
        yield* (yield* Db).recoverDelivering(harnessesWhoseAdapterPollsAsInboxLayerPasses, () => "")
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ id: number; status: string }>`SELECT id, status FROM inbox ORDER BY id`
      }).pipe(Effect.provide(database(file)))
      assert.deepStrictEqual(
        statuses.map((r) => [r.id, r.status]),
        [
          [ids[0], "pending"],
          [ids[1], "failed"],
        ],
      )
    }).pipe(Effect.provide(Platform.services)),
  )
})
