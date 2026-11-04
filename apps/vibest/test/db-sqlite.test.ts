import { Database } from "bun:sqlite"
import fs from "node:fs/promises"

import { SqliteClient } from "@effect/sql-sqlite-bun"
// What vibest relies on from SQLite and @effect/sql-sqlite-bun: file mode, WAL synchronous, the write lock.
import { assert, describe, it } from "@effect/vitest"
import { Storage } from "@vibest/core/storage"
import * as SqliteStorage from "@vibest/vibest/sqlite-storage"
import { SQL_NAMES } from "@vibest/vibest/sqlite-storage"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { launchMain, projectOf, tempDirectory } from "./fakes.ts"
import { MAIN_SCHEMA } from "./fixtures/main-schema.ts"

const database = (filename: string) => SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(filename)))

const modeOf = (path: string) => Effect.promise(async () => (await fs.stat(path)).mode & 0o777)

const modes = (file: string) =>
  Effect.gen(function* () {
    return { db: yield* modeOf(file), wal: yield* modeOf(`${file}-wal`), shm: yield* modeOf(`${file}-shm`) }
  })

describe("SQLite", () => {
  it.effect("a writable database is WAL with synchronous NORMAL", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-sync-")}/vibest.db`
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ journalMode: string }>`PRAGMA journal_mode`)[0]?.journalMode, "wal")
        // SQLite reports NORMAL as 1.
        assert.strictEqual((yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous, 1)
      }).pipe(Effect.provide(database(file)))
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("vibest.db and its wal and shm are mode 0600, including files that were looser", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-mode-")}/vibest.db`
      // The modes are read while the connection is open: closing the last connection may delete -wal and -shm
      // (SQLite's default, as on Linux), or keep them (Apple's system SQLite).
      const openModes = modes(file).pipe(Effect.provide(database(file)))
      assert.deepStrictEqual(yield* openModes, { db: 0o600, wal: 0o600, shm: 0o600 })
      // A connection held open through the second open: no other connection is the last to close, so SQLite neither
      // deletes nor recreates -wal and -shm, and only privateDatabase's chmod can bring the looser files back to 0600.
      yield* Effect.gen(function* () {
        const holder = Context.get(
          yield* Layer.build(SqliteClient.layer({ filename: file, ...SQL_NAMES })),
          SqlClient.SqlClient,
        )
        yield* holder`SELECT count(*) AS n FROM sqlite_master`
        yield* Effect.promise(() =>
          Promise.all([file, `${file}-wal`, `${file}-shm`].map((path) => fs.chmod(path, 0o644))),
        )
        assert.deepStrictEqual(yield* openModes, { db: 0o600, wal: 0o600, shm: 0o600 })
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

      // A short timeout so the second writer fails here instead of after the library default of 5 seconds.
      // The body only waits: BEGIN IMMEDIATE already holds the write lock, so the other transaction cannot start.
      const file = `${dir}/lock.db`
      // The holder opens through Platform.sqlite, so this half covers the connection vibest itself opens.
      const a = Context.get(yield* Layer.build(Platform.sqlite(file)), SqlClient.SqlClient)
      const b = Context.get(
        yield* Layer.build(SqliteClient.layer({ filename: file, busyTimeout: "50 millis", ...SQL_NAMES })),
        SqlClient.SqlClient,
      )
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const holder = yield* a
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      assert.strictEqual((yield* b<{ n: number }>`SELECT 1 AS n`)[0]?.n, 1)
      const exit = yield* b.withTransaction(b`SELECT 1 AS n`).pipe(Effect.exit)
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

  it.effect(
    "a file main's schema code made opens as is: its projects and sessions read through the engine's store",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDirectory("vibest-sqlite-main-")
        const file = `${dir}/vibest.db`
        const project = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"
        const main = "a1b2c3d4-0000-4000-8000-000000000001"
        const worker = "b2c3d4e5-0000-4000-8000-000000000002"
        // The rows as main's db.ts writes them: createProject, coordinatorLaunch, insertSession (12f3340).
        const made = new Database(file)
        for (const statement of MAIN_SCHEMA) made.run(statement)
        made.run("INSERT INTO project (id, directory) VALUES (?, ?)", [project, `${dir}/repo`])
        made.run("INSERT INTO project_repository (project_id, path, remote_url) VALUES (?, ?, ?)", [
          project,
          `${dir}/repo`,
          "git@github.com:o/r.git",
        ])
        made.run(
          "INSERT INTO session (id, project_id, role, name, machine, directory, created_at) VALUES (?, ?, 'main', 'main', 'local', ?, 1)",
          [main, project, `${dir}/repo`],
        )
        made.run("UPDATE project SET entry_session_id = ? WHERE id = ?", [main, project])
        made.run(
          "INSERT INTO session (id, project_id, parent_session_id, report_to_session_id, role, name, machine, directory, created_at) VALUES (?, ?, ?, ?, 'general', 'task', 'local', ?, 2)",
          [worker, project, main, main, `${dir}/wt`],
        )
        const start = (session: string, at: number, data: object) =>
          made.run("INSERT INTO event (at, session_id, type, data) VALUES (?, ?, 'process.start', ?)", [
            at,
            session,
            JSON.stringify(data),
          ])
        start(main, 1, { harness: "claude", runtime: "herdr", machine: "local", terminal: "w1:p1", resume: "conv-1" })
        start(worker, 2, { harness: "pi", runtime: "herdr", machine: "local", terminal: "w1:p2" })
        made.run(
          "INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, status) VALUES (?, 'task', ?, 'do it', 'delivered')",
          [worker, main],
        )
        made.close()
        yield* Effect.gen(function* () {
          const db = yield* Storage
          const projects = yield* SqliteStorage.ProjectStore
          assert.deepStrictEqual(yield* projects.projectAt(`${dir}/repo`), { id: project, directory: `${dir}/repo` })
          assert.strictEqual(yield* projects.projectDirectory(project), `${dir}/repo`)
          const row = (yield* db.getSession(worker))!
          assert.deepInclude(row, { scope: project, agent: "general", name: "task", harnessId: "pi" })
          assert.strictEqual(yield* db.sessionDirectory(worker), `${dir}/wt`)
          assert.deepInclude(yield* db.ownerOf(project), { id: main, harnessSessionId: "conv-1" })
          assert.deepStrictEqual(
            (yield* db.listSessions({ scope: project })).map((s) => s.id),
            [worker],
          )
          assert.strictEqual(yield* db.resolveSession(worker.slice(0, 8)), worker)
          assert.strictEqual((yield* db.sessionBriefs([worker])).get(worker)?.task, "do it")
        }).pipe(Effect.provide(database(file)))
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("two creates of one never-seen directory are the same project", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDirectory("vibest-sqlite-project-")}/vibest.db`
      const open = database(file)
      // The file exists before the two opens: two empty opens at once fail with SQLITE_CANTOPEN.
      yield* Effect.void.pipe(Effect.provide(open))
      const dir = `${file}-repo`
      const create = Effect.gen(function* () {
        return yield* (yield* SqliteStorage.ProjectStore).createProject(dir, [
          { path: `${dir}/app`, remote: "git@example.com:a.git" },
        ])
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
        const db = yield* Storage
        const place = (id: string) => ({ runtime: "fake", address: { machine: "local", id } })
        const ids: Array<number> = []
        for (const [key, harness] of [
          ["a", "claude"],
          ["b", "pi"],
        ] as const) {
          const { sessionId } = yield* launchMain(yield* projectOf(key), harness, false, place(key))
          const row = (yield* db.insertInbox({ sessionId, kind: "notice", message: key, details: {} }))[0]!
          assert.deepStrictEqual(yield* db.claim([row.id]), [row.id])
          ids.push(row.id)
        }
        return ids
      }).pipe(Effect.provide(database(file)))
      const statuses = yield* Effect.gen(function* () {
        // Inbox.layer runs this at start with the harnesses whose adapter polls.
        yield* (yield* Storage).recoverSending(["claude"])
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
