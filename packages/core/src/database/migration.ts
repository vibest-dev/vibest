import { randomId } from "@vibest/schema/id"
import { Clock, Effect, String as Str } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { Bus, checkReplay } from "../bus.ts"
import { APPEND_ONLY_TRIGGER, inspectSchema, LOG_SCHEMA, objectCount, PROJECTION_SCHEMA } from "./db-schema.ts"

export type Migration = {
  readonly id: string
  readonly up: (tx: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>
}

export const migrations: ReadonlyArray<Migration> = []

const appliedIds = (sql: SqlClient.SqlClient) =>
  sql<{ id: string }>`SELECT id FROM migration`.pipe(Effect.map((rows) => new Set(rows.map((row) => row.id))))

const markApplied = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${yield* Clock.currentTimeMillis})`
  })

export const installBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  for (const statement of [...LOG_SCHEMA, ...PROJECTION_SCHEMA]) yield* sql.unsafe(statement)
  yield* sql`INSERT INTO kv (key, value) VALUES ('ledger', ${randomId()})`
})

const bootstrap = (sql: SqlClient.SqlClient, input: ReadonlyArray<Migration>) =>
  sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* objectCount) > 0) return
      yield* installBaseline

      for (const migration of input) yield* markApplied(sql, migration.id)
    }),
  )

const pendingIn = (sql: SqlClient.SqlClient, input: ReadonlyArray<Migration>) =>
  appliedIds(sql).pipe(Effect.map((applied) => input.filter((migration) => !applied.has(migration.id))))

export const runMigrations = (
  sql: SqlClient.SqlClient,
  pending: ReadonlyArray<Migration>,
  record: (id: string) => Effect.Effect<void, SqlError.SqlError>,
) =>
  pending.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        yield* sql`DROP TRIGGER event_no_update`

        for (const migration of pending) {
          yield* migration.up(sql)
          yield* record(migration.id)
        }

        yield* sql.unsafe(APPEND_ONLY_TRIGGER)
      })

export const open = (input: ReadonlyArray<Migration> = migrations) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const known = new Set(input.map((m) => m.id))

    if ((yield* inspectSchema(known)) === "empty") {
      yield* bootstrap(sql, input)

      return
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const pending = yield* pendingIn(sql, input)

        if (pending.length > 0) yield* runMigrations(sql, pending, (id) => markApplied(sql, id))
      }),
    )
  })

type CopyRow = Readonly<Record<string, string | number | null>>

const copyDatabase = (from: SqlClient.SqlClient, to: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* to.unsafe("PRAGMA foreign_keys = OFF")
    yield* to.withTransaction(
      Effect.gen(function* () {
        const objects = yield* from<{ type: string; name: string; sql: string | null }>`SELECT type, name, sql
          FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END`

        for (const object of objects) {
          if (object.type === "table") yield* to.unsafe(object.sql!)
        }

        for (const object of objects) {
          if (object.type !== "table") continue

          const columns = (yield* from<{
            name: string
          }>`SELECT name FROM pragma_table_info(${object.name}) ORDER BY cid`).map((col) => col.name)

          const rows = yield* from.unsafe<CopyRow>(`SELECT * FROM "${object.name}"`)

          if (rows.length === 0) continue
          const cols = columns.map((c) => `"${c}"`).join(", ")
          const placeholders = columns.map(() => "?").join(", ")
          const insert = `INSERT INTO "${object.name}" (${cols}) VALUES (${placeholders})`

          for (const row of rows)
            yield* to.unsafe(
              insert,
              columns.map((c) => (c in row ? row[c] : row[Str.snakeToCamel(c)]) ?? null),
            )
        }

        for (const object of objects) {
          if (object.type !== "table") yield* to.unsafe(object.sql!)
        }
      }),
    )
    yield* to.unsafe("PRAGMA foreign_keys = ON")
  })

export const checkLedger = (stored: SqlClient.SqlClient, input: ReadonlyArray<Migration> = migrations) =>
  Effect.gen(function* () {
    const known = new Set(input.map((m) => m.id))
    const state = yield* inspectSchema(known).pipe(Effect.provideService(SqlClient.SqlClient, stored))

    if (state === "empty") return
    const pending = yield* pendingIn(stored, input)

    if (pending.length === 0) return yield* checkReplay(stored)
    const scratch = yield* SqlClient.SqlClient
    yield* copyDatabase(stored, scratch)
    yield* scratch.withTransaction(
      Effect.gen(function* () {
        yield* runMigrations(scratch, pending, (id) => markApplied(scratch, id))
        yield* (yield* Bus.Service).rebuild
      }),
    )
  })
