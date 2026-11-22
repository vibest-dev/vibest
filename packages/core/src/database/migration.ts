import { CATALOG_VERSION } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Clock, Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { Bus, checkReplay, copyWholeLog } from "../bus.ts"
import {
  APPEND_ONLY_TRIGGER,
  inspectSchema,
  LOG_SCHEMA,
  MIGRATION_TABLE,
  objectCount,
  PROJECTION_SCHEMA,
  PROJECTION_VERSION,
  setMeta,
} from "./db-schema.ts"
import { migration as oneSender } from "./migration/20261119000000_one_sender.ts"
import { migration as limitedEndIsExited } from "./migration/20261120000000_limited_end_is_exited.ts"
import { migration as executionLifecycle } from "./migration/20261122000000_execution_lifecycle.ts"

export type Migration = {
  readonly id: string
  readonly up: (tx: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>
}

export const migrations: ReadonlyArray<Migration> = [oneSender, limitedEndIsExited, executionLifecycle]

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

const bootstrap = (sql: SqlClient.SqlClient, input: ReadonlyArray<Migration>) =>
  sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* objectCount) > 0) return
      yield* installLedger
      yield* createTable(sql)

      for (const migration of input) yield* markApplied(sql, migration.id)
    }),
  )

const projectionVersion = (sql: SqlClient.SqlClient) =>
  sql<{ value: string }>`SELECT value FROM meta WHERE key = 'projection'`.pipe(
    Effect.map((rows) => Number(rows[0]?.value)),
  )

const catalogVersion = (sql: SqlClient.SqlClient) =>
  sql<{ value: string }>`SELECT value FROM meta WHERE key = 'catalog'`.pipe(
    Effect.map((rows) => Number(rows[0]?.value)),
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

const openLedger = (sql: SqlClient.SqlClient, input: ReadonlyArray<Migration>) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const pending = yield* pendingIn(sql, input)

        const stale =
          pending.length > 0 ||
          (yield* catalogVersion(sql)) !== CATALOG_VERSION ||
          (yield* projectionVersion(sql)) !== PROJECTION_VERSION

        yield* runMigrations(sql, pending, (id) => markApplied(sql, id))

        if (stale) yield* bus.rebuild
        yield* setMeta(sql, "catalog", CATALOG_VERSION)
      }),
    )
  })

export const open = (input: ReadonlyArray<Migration> = migrations) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    if ((yield* inspectSchema) === "empty") yield* bootstrap(sql, input)
    yield* openLedger(sql, input)
  })

const copyMeta = (stored: SqlClient.SqlClient, scratch: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const row of yield* stored<{ key: string; value: string }>`SELECT key, value FROM meta`)
      yield* scratch`INSERT INTO meta (key, value) VALUES (${row.key}, ${row.value})`
  })

export const checkLedger = (stored: SqlClient.SqlClient, input: ReadonlyArray<Migration> = migrations) =>
  Effect.gen(function* () {
    const pending = yield* pendingIn(stored, input)

    if (pending.length === 0 && (yield* catalogVersion(stored)) === CATALOG_VERSION) return yield* checkReplay(stored)
    const scratch = yield* SqlClient.SqlClient
    yield* scratch.withTransaction(
      Effect.gen(function* () {
        yield* copyWholeLog(stored, scratch)
        yield* copyMeta(stored, scratch)
        yield* runMigrations(scratch, pending, () => Effect.void)
        yield* (yield* Bus.Service).rebuild
      }),
    )
  })
