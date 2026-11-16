import { CATALOG_VERSION } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Clock, Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { Bus } from "../bus.ts"
import {
  inspectSchema,
  LOG_SCHEMA,
  MIGRATION_TABLE,
  objectCount,
  PROJECTION_SCHEMA,
  PROJECTION_VERSION,
  setMeta,
} from "./db-schema.ts"

export type Migration = {
  readonly id: string
  readonly up: (tx: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>
}

export const migrations: ReadonlyArray<Migration> = []

const createTable = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)
    STRICT`)

const appliedIds = (sql: SqlClient.SqlClient) =>
  sql<{ id: string }>`SELECT id FROM migration`.pipe(Effect.map((rows) => new Set(rows.map((row) => row.id))))

const markApplied = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${yield* Clock.currentTimeMillis})`
  })

export const installLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of [...LOG_SCHEMA, ...PROJECTION_SCHEMA]) yield* sql.unsafe(statement)
  yield* setMeta(sql, "catalog", CATALOG_VERSION)
  yield* setMeta(sql, "projection", PROJECTION_VERSION)
  yield* sql`INSERT INTO meta (key, value) VALUES ('ledger', ${randomId()})`
})

const bootstrap = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* objectCount) > 0) return
      yield* installLedger
      yield* createTable(sql)
      for (const migration of migrations) yield* markApplied(sql, migration.id)
    }),
  )

export const applyOnly = (input: ReadonlyArray<Migration>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const migration of input)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if ((yield* appliedIds(sql)).has(migration.id)) return
          yield* migration.up(sql)
          yield* markApplied(sql, migration.id)
        }),
      )
  })

const projectionVersion = (sql: SqlClient.SqlClient) =>
  sql<{ value: string }>`SELECT value FROM meta WHERE key = 'projection'`.pipe(
    Effect.map((rows) => Number(rows[0]?.value)),
  )

const openLedger = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* projectionVersion(sql)) !== PROJECTION_VERSION) yield* bus.rebuild
        yield* sql`UPDATE meta SET value = ${String(CATALOG_VERSION)} WHERE key = 'catalog'`
      }),
    )
  })

export const apply = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if ((yield* inspectSchema) === "empty") yield* bootstrap(sql)
  yield* applyOnly(migrations)
  yield* inspectSchema
  yield* openLedger(sql)
})
