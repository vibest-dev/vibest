import { Database } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { APPLICATION_ID, PROJECTION_VERSION } from "@vibest/core/database/db-schema"
import { applyOnly, type Migration, migrations } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import { tempDirectory, projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { database, session, place } from "@vibest/platform-bun/test/lib/unit-helpers"
import { CATALOG_VERSION } from "@vibest/schema/event"
import { ID } from "@vibest/schema/id"
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const ENTRY = { agent: "coordinator" } as const

describe("Db", () => {
  const fileAt = (dir: string, name: string) => Path.Path.pipe(Effect.map((path) => path.join(dir, name)))

  const header = (file: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        applicationId: (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0,
        userVersion: (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0,
        objects: (yield* sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`)[0]?.n ?? 0,
      }
    }).pipe(Effect.provide(Platform.sqlite(file)))

  const writeSql = (file: string, statements: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      for (const statement of statements) yield* sql.unsafe(statement)
    }).pipe(Effect.provide(Platform.sqlite(file)))

  const refusal = (file: string) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.void.pipe(Effect.provide(database(file))))
      assert.isTrue(Exit.isFailure(exit))

      return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    })

  const brokenInstall = (file: string, how: "fail" | "interrupt") =>
    Db.layer.pipe(
      Layer.provide(Projectors.layer),
      Layer.provide(Bus.layer),
      Layer.provide(SessionLive.layer),
      Layer.provide(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            const unsafe = (statement: string, params?: ReadonlyArray<unknown>) =>
              statement.includes("event_no_update")
                ? how === "interrupt"
                  ? Effect.interrupt
                  : Effect.fail(new Error("injected schema failure"))
                : sql.unsafe(statement, params)

            return Object.assign(sql.bind(undefined), sql, { unsafe }) satisfies SqlClient.SqlClient
          }),
        ).pipe(Layer.provide(Platform.sqlite(file))),
      ),
    )

  it.effect("a failed or interrupted install rolls back, then a later open initializes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-schema-rollback-")

      for (const how of ["fail", "interrupt"] as const) {
        const file = yield* fileAt(dir, `${how}.db`)
        const exit = yield* Effect.exit(Effect.void.pipe(Effect.provide(brokenInstall(file, how))))
        assert.isTrue(
          how === "interrupt" ? Exit.hasInterrupts(exit) : Exit.isFailure(exit) && !Exit.hasInterrupts(exit),
        )
        assert.deepStrictEqual(yield* header(file), { applicationId: 0, userVersion: 0, objects: 0 })
        yield* Effect.gen(function* () {
          const db = yield* Db.Service
          assert.isTrue(
            yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r")),
          )
          assert.match((yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).sessionId, ID)
        }).pipe(Effect.provide(database(file)))
        assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
        assert.deepStrictEqual(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            return (yield* sql<{ id: string }>`SELECT id FROM migration ORDER BY id`).map((row) => row.id)
          }).pipe(Effect.provide(Platform.sqlite(file))),
          migrations.map((migration) => migration.id),
        )
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a database with another read-model version is rebuilt at open and keeps its migration rows; it opens again",
    () =>
      Effect.gen(function* () {
        const file = yield* fileAt(yield* tempDirectory("vibest-projection-"), "vibest.db")

        const sessions = Effect.flatMap(Db.Service, (db) => db.session.listSessions({ stopped: true })).pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.provide(database(file)),
        )

        yield* Effect.gen(function* () {
          const db = yield* Db.Service
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        }).pipe(Effect.provide(database(file)))
        yield* writeSql(file, [
          "INSERT INTO migration (id, time_completed) VALUES ('20270101000000_kept', 1)",
          "UPDATE meta SET value = '0' WHERE key = 'projection'",
        ])
        assert.deepStrictEqual(yield* sessions, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
        assert.deepStrictEqual(yield* sessions, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])

        const kept = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          return {
            ids: (yield* sql<{ id: string }>`SELECT id FROM migration`).map((row) => row.id),
            projection: (yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'projection'`)[0]?.value,
          }
        }).pipe(Effect.provide(Platform.sqlite(file)))

        assert.deepStrictEqual(kept, { ids: ["20270101000000_kept"], projection: String(PROJECTION_VERSION) })
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("pending migrations run in order at open, each once and recorded; a failing one changes nothing", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-migrations-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))
      const ran: Array<string> = []

      const creating = (id: string, table: string, fails = false): Migration => ({
        id,
        up: (tx) =>
          tx.unsafe(`CREATE TABLE ${table} (x INTEGER) STRICT`).pipe(
            Effect.tap(() => Effect.sync(() => ran.push(id))),
            Effect.andThen(fails ? Effect.die("injected migration failure") : Effect.void),
          ),
      })

      const state = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        return {
          ids: (yield* sql<{ id: string }>`SELECT id FROM migration ORDER BY id`).map((row) => row.id),
          tables: (yield* sql<{
            name: string
          }>`SELECT name FROM sqlite_schema WHERE name LIKE 'later_%' ORDER BY name`).map((row) => row.name),
        }
      })

      const steps = [creating("20270101000000_a", "later_a"), creating("20270102000000_b", "later_b")]
      yield* applyOnly(steps).pipe(Effect.provide(Platform.sqlite(file)))
      yield* applyOnly(steps).pipe(Effect.provide(Platform.sqlite(file)))
      assert.deepStrictEqual(ran, ["20270101000000_a", "20270102000000_b"])
      const failing = applyOnly([...steps, creating("20270103000000_c", "later_c", true)])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(failing.pipe(Effect.provide(Platform.sqlite(file))))))
      assert.deepStrictEqual(yield* state.pipe(Effect.provide(Platform.sqlite(file))), {
        ids: ["20270101000000_a", "20270102000000_b"],
        tables: ["later_a", "later_b"],
      })
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an incomplete file is rejected and left byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-partial-")
      const dropped = yield* fileAt(dir, "missing-table.db")
      yield* Effect.void.pipe(Effect.provide(database(dropped)))
      yield* writeSql(dropped, ["DROP INDEX project_repository_project", "DROP TABLE project_repository"])
      const droppedBytes = yield* fs.readFile(dropped)
      assert.include(yield* refusal(dropped), "missing project_repository")
      assert.deepStrictEqual(yield* fs.readFile(dropped), droppedBytes)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a file of the shape before the event table (version 1 too, no event table) is refused, naming its path and how to move it aside",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-schema-v1-"), "vibest.db")
        yield* writeSql(file, [
          `PRAGMA application_id = ${APPLICATION_ID}`,
          "PRAGMA user_version = 1",
          "CREATE TABLE project (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, main_session_id TEXT)",
          "CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL)",
          "CREATE TABLE inbox (id INTEGER PRIMARY KEY)",
        ])
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.include(pretty, `${file} is from an older vibest`)
        assert.include(pretty, "the sessions, results and queued messages it holds are lost")
        assert.notInclude(pretty, "migration script")
        assert.deepStrictEqual(yield* fs.readFile(file), before)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "import-check replays the log: it passes on a ledger, names the first row a changed read model differs in, and only replays an older read model",
    () =>
      Effect.gen(function* () {
        const file = yield* fileAt(yield* tempDirectory("vibest-import-check-"), "vibest.db")
        yield* Effect.gen(function* () {
          const db = yield* Db.Service
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        }).pipe(Effect.provide(database(file)))
        yield* Platform.daemon.checkDatabase(file)
        yield* writeSql(file, ["UPDATE session SET name = 'changed'"])
        const differs = yield* Effect.flip(Platform.daemon.checkDatabase(file))
        assert.strictEqual(differs._tag, "ReplayDiffers")
        assert.match(differs.message, /^the read model differs from a replay of its log: session row 1/)
        yield* writeSql(file, ["UPDATE meta SET value = '0' WHERE key = 'projection'"])
        yield* Platform.daemon.checkDatabase(file)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a foreign database with user_version 1, or ours written by a newer event catalog, is refused without changing its bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-schema-foreign-"), "other.db")
        yield* writeSql(file, [
          "CREATE TABLE other (id INTEGER PRIMARY KEY, note TEXT)",
          "INSERT INTO other (id, note) VALUES (1, 'keep-me')",
          "PRAGMA user_version = 1",
        ])
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.match(pretty, /SchemaMismatch/)
        assert.match(pretty, /application_id 0x0, v1/)
        assert.notMatch(pretty, /0x76696265/)
        assert.include(pretty, `${file} is not this vibest's schema`)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
        assert.isFalse(yield* fs.exists(`${file}-wal`))
        assert.isFalse(yield* fs.exists(`${file}-shm`))
        assert.match(yield* refusal(file), /application_id 0x0, v1/)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
        const reader = new Database(file, { readonly: true })
        assert.strictEqual((reader.query("SELECT note FROM other").get() as { note: string } | null)?.note, "keep-me")
        reader.close()

        const newer = yield* fileAt(yield* tempDirectory("vibest-schema-newer-"), "vibest.db")
        yield* Effect.void.pipe(Effect.provide(database(newer)))
        yield* writeSql(newer, [`UPDATE meta SET value = '${CATALOG_VERSION + 1}' WHERE key = 'catalog'`])
        const newerBytes = yield* fs.readFile(newer)
        const newerSaid = yield* refusal(newer)
        assert.match(newerSaid, /SchemaMismatch/)
        assert.include(
          newerSaid,
          `${newer} was written by a newer vibest (event catalog ${CATALOG_VERSION + 1}, this vibest knows ${CATALOG_VERSION}): run vibest update`,
        )
        assert.deepStrictEqual(yield* fs.readFile(newer), newerBytes)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("vibestd and import-check refuse a database in the old event shape and point to the CHANGELOG", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fileAt(yield* tempDirectory("vibest-schema-old-shape-"), "vibest.db")
      yield* writeSql(file, [
        `PRAGMA application_id = ${0x76696265}`,
        "CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, project_id TEXT, session_id TEXT, data TEXT NOT NULL) STRICT",
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT",
        "INSERT INTO meta VALUES ('catalog', '1'), ('projection', '4')",
      ])
      const before = yield* fs.readFile(file)
      const said = `${file} is from an older vibest (its event log is the shape from before per-aggregate events): see "The event log is per aggregate" in the vibest CHANGELOG.`
      assert.include(yield* refusal(file), said)
      const checked = (yield* Effect.flip(Platform.daemon.checkDatabase(file))).message
      assert.include(checked, said)
      assert.notInclude(checked, "tools/")
      assert.deepStrictEqual(yield* fs.readFile(file), before)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a hot foreign WAL is refused without checkpointing the database or WAL (the writer keeps its db reachable: Bun's GC would checkpoint it)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* tempDirectory("vibest-schema-hot-")
        const file = yield* fileAt(dir, "hot.db")
        const ready = yield* fileAt(dir, "ready")
        const maker = yield* fileAt(dir, "maker.ts")
        const keepDbAlive = "setInterval(() => db, 1000)"
        yield* fs.writeFileString(
          maker,
          [
            'import { Database } from "bun:sqlite"',
            'import { writeFileSync } from "node:fs"',
            "const db = new Database(process.argv[2])",
            'db.exec("PRAGMA journal_mode = WAL")',
            'db.exec("BEGIN")',
            'db.exec("CREATE TABLE other (id INTEGER PRIMARY KEY, note TEXT)")',
            "db.exec(\"INSERT INTO other VALUES (1, 'keep-me')\")",
            'for (let i = 0; i < 400; i++) db.run("INSERT INTO other (note) VALUES (?)", ["x".repeat(80)])',
            'db.exec("PRAGMA user_version = 1")',
            'db.exec("COMMIT")',
            "writeFileSync(process.argv[3], 'ok')",
            keepDbAlive,
            "",
          ].join("\n"),
        )
        const proc = Bun.spawn(["bun", maker, file, ready], { stdout: "pipe", stderr: "pipe" })
        yield* Effect.gen(function* () {
          while (!(yield* fs.exists(ready))) {
            if (proc.exitCode !== null) return yield* Effect.die("hot wal helper exited before it was ready")
            yield* Effect.promise(() => Bun.sleep(20))
          }
        })
        proc.kill(9)
        yield* Effect.promise(() => proc.exited)
        const dbBefore = yield* fs.readFile(file)
        const walBefore = yield* fs.readFile(`${file}-wal`)
        assert.isTrue(walBefore.length > 0)
        const pretty = yield* refusal(file)
        assert.include(pretty, "SchemaMismatch")
        assert.include(pretty, "application_id 0x0, v1")
        assert.deepStrictEqual(yield* fs.readFile(file), dbBefore)
        assert.deepStrictEqual(yield* fs.readFile(`${file}-wal`), walBefore)
        const reader = new Database(file, { readonly: true })
        assert.strictEqual(
          (reader.query("SELECT note FROM other WHERE id = 1").get() as { note: string } | null)?.note,
          "keep-me",
        )
        reader.close()
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("two empty opens both initialize", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-race-")
      const file = yield* fileAt(dir, "vibest.db")
      const script = yield* fileAt(dir, "open.ts")
      const dbModule = url.fileURLToPath(new URL("../../../packages/core/src/database/db.ts", import.meta.url))
      const busModule = url.fileURLToPath(new URL("../../../packages/core/src/bus.ts", import.meta.url))

      const projectorsModule = url.fileURLToPath(
        new URL("../../../packages/core/src/database/projectors.ts", import.meta.url),
      )

      const liveModule = url.fileURLToPath(new URL("../../../packages/core/src/session/live.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../../platform-bun/src/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import { Bus } from ${JSON.stringify(busModule)}`,
          `import * as Projectors from ${JSON.stringify(projectorsModule)}`,
          `import { SessionLive } from ${JSON.stringify(liveModule)}`,
          `import { Db } from ${JSON.stringify(dbModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(Db.layer.pipe(Layer.provide(Projectors.layer), Layer.provide(Bus.layer), Layer.provide(SessionLive.layer), Layer.provide(Platform.sqlite(process.argv[2]!))))))",
          "",
        ].join("\n"),
      )
      const spawn = () => Bun.spawn(["bun", script, file], { stdout: "pipe", stderr: "pipe" })
      const [a, b] = [spawn(), spawn()]

      const [codeA, codeB, errA, errB] = yield* Effect.promise(() =>
        Promise.all([a.exited, b.exited, new Response(a.stderr).text(), new Response(b.stderr).text()]),
      )

      assert.deepStrictEqual([codeA, errA, codeB, errB], [0, "", 0, ""])
      assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
    }).pipe(Effect.provide(Platform.services)),
  )
})
