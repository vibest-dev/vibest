import { Database as SqliteDatabase } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Database } from "@vibest/core/database/database"
import { checkLedger, type Migration, migrations, open } from "@vibest/core/database/migration"
import { APPLICATION_ID } from "@vibest/core/database/schema.sql"
import { InboxStore } from "@vibest/core/inbox/store"
import { ProjectStore } from "@vibest/core/project/store"
import { Projectors } from "@vibest/core/reactor"
import { RemoteStore } from "@vibest/core/remote/store"
import { SessionLive } from "@vibest/core/session/live"
import { SessionStore } from "@vibest/core/session/store"
import { Event } from "@vibest/schema/event"
import { ID } from "@vibest/schema/id"
import { tempDirectory, projectOf } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { database, session, place } from "@vibest/testkit/unit-helpers"
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

const ENTRY = { agent: "coordinator" } as const
const builtIn = migrations.map((migration) => migration.id)

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
    Layer.mergeAll(ProjectStore.layer, SessionStore.layer, InboxStore.layer, RemoteStore.layer).pipe(
      Layer.provideMerge(Database.layer),
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
          const db = { session: yield* SessionStore.Service }
          assert.isTrue(
            yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r")),
          )
          assert.match((yield* db.session.startRoot(yield* projectOf("r"), "pi", false, place, ENTRY)).sessionId, ID)
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

  it.effect("reopening an existing database does not drop operational tables and preserves its data", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-reopen-o1-"), "vibest.db")
      const quietPlace = { ...place, target: { id: "test/p2" } }

      const ids = yield* Effect.gen(function* () {
        const db = { session: yield* SessionStore.Service }
        const reported = yield* db.session.startRoot(yield* projectOf("known"), "pi", false, place, ENTRY)
        yield* db.session.noteConversation(reported.sessionId, "conv-known")
        const quiet = yield* db.session.startRoot(yield* projectOf("unknown"), "pi", false, quietPlace, ENTRY)

        return { reported: reported.sessionId, quiet: quiet.sessionId }
      }).pipe(Effect.provide(database(file)))

      yield* Effect.void.pipe(Effect.provide(database(file)))

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        return yield* sql<{
          sessionId: string
          harnessSessionId: string | null
        }>`SELECT session_id, harness_session_id FROM process`
      }).pipe(Effect.provide(Platform.sqlite(file)))

      assert.strictEqual(rows.find((row) => row.sessionId === ids.reported)?.harnessSessionId, "conv-known")
      assert.strictEqual(rows.find((row) => row.sessionId === ids.quiet)?.harnessSessionId, null)
    }).pipe(Effect.provide(Platform.services)),
  )

  const knownOf = (steps: ReadonlyArray<Migration>) => new Set([...builtIn, ...steps.map((m) => m.id)])

  const runner = (file: string, steps: ReadonlyArray<Migration> = []) =>
    Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file, knownOf(steps))))

  const ledgerOf = (file: string, steps: ReadonlyArray<Migration> = []) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all([
        sql`SELECT * FROM event ORDER BY position`,
        sql`SELECT * FROM kv ORDER BY key`,
        sql`SELECT id FROM migration ORDER BY id`,
        sql`SELECT * FROM project ORDER BY id`,
      ]),
    ).pipe(Effect.provide(Platform.sqlite(file, knownOf(steps))))

  const checkOn = (file: string, steps: ReadonlyArray<Migration>) =>
    Effect.gen(function* () {
      const stored = yield* Layer.build(Platform.sqlite(file, knownOf(steps))).pipe(
        Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
      )

      return yield* Effect.exit(
        checkLedger(stored, steps).pipe(
          Effect.provide(Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))),
        ),
      )
    }).pipe(Effect.scoped)

  const failureOf = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

  it.effect("pending migrations run in order at open, each once and recorded; a failing one changes nothing", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-migrations-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))
      const ran: Array<string> = []

      const marking = (id: string, key: string, fails = false): Migration => ({
        id,
        up: (tx) =>
          tx`INSERT INTO kv (key, value) VALUES (${key}, ${id})`.pipe(
            Effect.tap(() => Effect.sync(() => ran.push(id))),
            Effect.andThen(fails ? Effect.die("injected migration failure") : Effect.void),
          ),
      })

      const state = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        return {
          ids: (yield* sql<{ id: string }>`SELECT id FROM migration ORDER BY id`).map((row) => row.id),
          marks: (yield* sql<{ key: string }>`SELECT key FROM kv WHERE key LIKE 'later_%' ORDER BY key`).map(
            (row) => row.key,
          ),
        }
      })

      const steps = [marking("20270101000000_a", "later_a"), marking("20270102000000_b", "later_b")]
      yield* open(steps).pipe(Effect.provide(runner(file, steps)))
      yield* open(steps).pipe(Effect.provide(runner(file, steps)))
      assert.deepStrictEqual(ran, ["20270101000000_a", "20270102000000_b"])
      const before = yield* ledgerOf(file, steps)
      const failingSteps = [...steps, marking("20270103000000_c", "later_c", true)]
      const failing = open(failingSteps)
      assert.isTrue(Exit.isFailure(yield* Effect.exit(failing.pipe(Effect.provide(runner(file, failingSteps))))))
      assert.deepStrictEqual(yield* ledgerOf(file, steps), before, "the failed open rolled everything back")
      assert.deepStrictEqual(yield* state.pipe(Effect.provide(Platform.sqlite(file, knownOf(steps)))), {
        ids: [...builtIn, "20270101000000_a", "20270102000000_b"],
        marks: ["later_a", "later_b"],
      })
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("import-check runs a migration against the file's kv as open does, so a collision fails both", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-migration-kv-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))

      const colliding: Migration = {
        id: "20270101000000_ledger_again",
        up: (tx) => tx`INSERT INTO kv (key, value) VALUES ('ledger', 'again')`,
      }

      assert.include(failureOf(yield* checkOn(file, [colliding])), "kv.key")
      assert.include(failureOf(yield* Effect.exit(open([colliding]).pipe(Effect.provide(runner(file))))), "kv.key")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an event whose projector fails during replay is named by its aggregate and seq", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-replay-projector-"), "vibest.db")
      const twice = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      yield* Effect.void.pipe(Effect.provide(database(file)))
      yield* writeSql(file, [
        `INSERT INTO event_sequence (aggregate_id, seq) VALUES ('${twice}', 2)`,
        `INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('${Event.createId()}', '${twice}', 1, 5, 'project.created.1', '{"projectId":"${twice}","directory":"/twice-1","repositories":[]}')`,
        `INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('${Event.createId()}', '${twice}', 2, 5, 'project.created.1', '{"projectId":"${twice}","directory":"/twice-2","repositories":[]}')`,
      ])
      const nothing: Migration = { id: "20270101000000_nothing", up: () => Effect.void }

      assert.include(
        failureOf(yield* checkOn(file, [nothing])),
        `event ${twice} 2: project.created cannot be projected`,
      )
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a migration rewrites an old-shape event in place at open and import-check runs it on a copy; without it import-check refuses the event by its aggregate and seq",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-migrate-event-"), "vibest.db")
        const old = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        yield* Effect.void.pipe(Effect.provide(database(file)))
        yield* writeSql(file, [
          `INSERT INTO event_sequence (aggregate_id, seq) VALUES ('${old}', 1)`,
          `INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('${Event.createId()}', '${old}', 1, 5, 'project.created.1', '{"projectId":"${old}","directory":"/old"}')`,
        ])

        const fill: Migration = {
          id: "20270101000000_repositories",
          up: (tx) =>
            tx`UPDATE event SET data = json_set(data, '$.repositories', json('[]'))
              WHERE type = 'project.created.1' AND json_extract(data, '$.repositories') IS NULL`,
        }

        const check = (steps: ReadonlyArray<Migration>) => checkOn(file, steps)

        assert.include(failureOf(yield* check([])), `event ${old} 1`)

        const before = yield* fs.readFile(file)
        assert.isTrue(Exit.isSuccess(yield* check([fill])))
        assert.deepStrictEqual(yield* fs.readFile(file), before, "import-check migrates only its copy")

        yield* open([fill]).pipe(Effect.provide(runner(file, [fill])))
        yield* open([fill]).pipe(Effect.provide(runner(file, [fill])))
        assert.deepStrictEqual(
          yield* Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{ data: string; applied: number }>`SELECT data,
              (SELECT count(*) FROM migration WHERE id = ${fill.id}) AS applied
              FROM event WHERE aggregate_id = ${old}`,
          ).pipe(Effect.provide(Platform.sqlite(file, knownOf([fill])))),
          [{ data: `{"projectId":"${old}","directory":"/old","repositories":[]}`, applied: 1 }],
        )
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("import-check succeeds on an empty database and runs pending ALTER TABLE migrations on a copy", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-check-empty-and-ddl-")
      const emptyFile = yield* fileAt(dir, "empty.db")
      assert.isTrue(Exit.isSuccess(yield* checkOn(emptyFile, [])))

      const file = yield* fileAt(dir, "ddl.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))

      const addColumn: Migration = {
        id: "20270101000000_add_session_note",
        up: (tx) => tx.unsafe("ALTER TABLE session ADD COLUMN note TEXT"),
      }

      assert.isTrue(Exit.isSuccess(yield* checkOn(file, [addColumn])))

      const columns = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ name: string }>`SELECT name FROM pragma_table_info('session')`,
      ).pipe(Effect.provide(Platform.sqlite(file)))

      assert.isFalse(columns.some((col) => col.name === "note"))
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
    "import-check replays the log: it passes on a ledger and names the first row a changed read model differs in",
    () =>
      Effect.gen(function* () {
        const file = yield* fileAt(yield* tempDirectory("vibest-import-check-"), "vibest.db")
        yield* Effect.gen(function* () {
          const db = { session: yield* SessionStore.Service }
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        }).pipe(Effect.provide(database(file)))
        yield* Platform.daemon.checkDatabase(file)
        yield* writeSql(file, ["UPDATE session SET name = 'changed'"])
        const differs = yield* Effect.flip(Platform.daemon.checkDatabase(file))
        assert.strictEqual(differs._tag, "ReplayDiffers")
        assert.match(differs.message, /^the read model differs from a replay of its log: session row 1/)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a foreign database with user_version 1, or ours migrated by a newer vibest, is refused without changing its bytes",
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
        const reader = new SqliteDatabase(file, { readonly: true })
        assert.strictEqual((reader.query("SELECT note FROM other").get() as { note: string } | null)?.note, "keep-me")
        reader.close()

        const newer = yield* fileAt(yield* tempDirectory("vibest-schema-newer-"), "vibest.db")
        yield* Effect.void.pipe(Effect.provide(database(newer)))
        yield* writeSql(newer, [
          "INSERT INTO migration (id, time_completed) VALUES ('20990101000000_future_feature', 1)",
        ])
        const newerBytes = yield* fs.readFile(newer)
        const newerSaid = yield* refusal(newer)
        assert.match(newerSaid, /SchemaMismatch/)
        assert.include(
          newerSaid,
          `${newer} was migrated by a newer vibest (migration 20990101000000_future_feature): run vibest update`,
        )
        assert.deepStrictEqual(yield* fs.readFile(newer), newerBytes)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "vibestd and import-check refuse a pre-v2 database without modifying it or naming any migration script",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-schema-old-shape-"), "vibest.db")
        yield* writeSql(file, [
          `PRAGMA application_id = ${APPLICATION_ID}`,
          "CREATE TABLE event (position INTEGER PRIMARY KEY AUTOINCREMENT, aggregate TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL) STRICT",
          "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
          "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT",
          "INSERT INTO meta VALUES ('catalog', '16'), ('projection', '26')",
        ])
        const before = yield* fs.readFile(file)
        const refused = yield* refusal(file)
        assert.include(refused, `${file} is from an older vibest`)
        assert.notInclude(refused, "migration script")
        assert.notInclude(refused, "tools/")
        const checked = (yield* Effect.flip(Platform.daemon.checkDatabase(file))).message
        assert.include(checked, `${file} is from an older vibest`)
        assert.notInclude(checked, "migration script")
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
        const reader = new SqliteDatabase(file, { readonly: true })
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
      const dbModule = url.fileURLToPath(new URL("../../../packages/core/src/database/database.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../../platform-bun/src/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import { Database } from ${JSON.stringify(dbModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(Database.layer.pipe(Layer.provide(Platform.sqlite(process.argv[2]!))))))",
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

  it.effect("restricts vibest.db and its WAL/SHM sidecars to owner-only 0o600 permissions on POSIX", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-db-perms-")
      const file = yield* fileAt(dir, "vibest.db")
      yield* fs.writeFileString(file, "")
      yield* fs.writeFileString(`${file}-wal`, "")
      yield* fs.writeFileString(`${file}-shm`, "")
      yield* fs.chmod(file, 0o644)
      yield* fs.chmod(`${file}-wal`, 0o644)
      yield* fs.chmod(`${file}-shm`, 0o644)

      yield* Effect.void.pipe(Effect.provide(Database.layer.pipe(Layer.provide(Platform.sqlite(file)))))

      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${file}${suffix}`

        if (yield* fs.exists(candidate)) {
          const info = yield* fs.stat(candidate)
          assert.strictEqual(info.mode & 0o777, 0o600)
        }
      }
    }).pipe(Effect.provide(Platform.services)),
  )
})
