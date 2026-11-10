import { CATALOG_VERSION } from "@vibest/schema/event"
import { shellQuote } from "@vibest/schema/layout"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { PROJECTION_SCHEMA, PROJECTION_VERSION } from "./projectors.ts"

export const APPLICATION_ID = 0x76696265

export const MIGRATION_TABLE = "migration"

export const LOG_SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `CREATE TABLE event (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    project_id TEXT,
    session_id TEXT,
    data       TEXT    NOT NULL
  ) STRICT`,
  `CREATE TRIGGER event_no_update BEFORE UPDATE ON event
    BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
]

const objectsOf = (schema: ReadonlyArray<string>) =>
  schema.flatMap((statement) => {
    const found = /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/.exec(statement)
    return found ? [{ type: found[1]!.toLowerCase(), name: found[2]! }] : []
  })

export class DatabaseOpenFailed extends Schema.TaggedError<DatabaseOpenFailed>()("DatabaseOpenFailed", {
  file: Schema.String,
  message: Schema.String,
}) {}

export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
  version: Schema.Number,
  applicationId: Schema.Number,
  detail: Schema.optional(Schema.String),
  older: Schema.optional(Schema.Boolean),
  catalog: Schema.optional(Schema.Number),
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    const file = this.file ?? "vibest.db"
    if (this.catalog !== undefined)
      return `${file} was written by a newer vibest (event catalog ${this.catalog}, this vibest knows ${CATALOG_VERSION}): run vibest update`
    const aside = `To start empty, with vibestd stopped, move it aside with its -wal and -shm files: for f in ${["", "-wal", "-shm"].map((suffix) => shellQuote(file + suffix)).join(" ")}; do [ -e "$f" ] && mv "$f" "$f.old"; done (the sessions, results and queued messages it holds are lost; agents still running keep running, but vibest no longer knows them)`
    if (this.older)
      return `${file} is from an older vibest (its tables are the shape from before this release). ${aside}`
    const id = `0x${(this.applicationId >>> 0).toString(16)}`
    const extra = this.detail === undefined ? "" : `, ${this.detail}`
    return `${file} is not this vibest's schema (application_id ${id}, v${this.version}${extra}). ${aside}`
  }
}

export const mismatch = (version: number, applicationId: number, detail?: string) =>
  new SchemaMismatch({ version, applicationId, ...(detail === undefined ? {} : { detail }) })

const metaOf = (sql: SqlClient.SqlClient, key: "catalog" | "projection") =>
  sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`.pipe(
    Effect.map((rows) => (rows[0] === undefined ? undefined : Number(rows[0].value))),
  )

export const inspectSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql.unsafe<{ type: string; name: string }>("SELECT type, name FROM sqlite_master")
  if (rows.length === 0) return "empty" as const
  const applicationId = (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0
  const userVersion = (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0
  const has = (type: string, name: string) => rows.some((row) => row.type === type && row.name === name)
  if (applicationId !== APPLICATION_ID) return yield* mismatch(userVersion, applicationId)
  if (!has("table", MIGRATION_TABLE))
    return yield* new SchemaMismatch({ version: userVersion, applicationId, older: true })
  const catalog = has("table", "meta") ? yield* metaOf(sql, "catalog") : undefined
  if (catalog === undefined) return yield* mismatch(userVersion, applicationId, "no event catalog version")
  if (catalog > CATALOG_VERSION) return yield* new SchemaMismatch({ version: userVersion, applicationId, catalog })
  const rebuilt = (yield* metaOf(sql, "projection")) !== PROJECTION_VERSION
  const absent = objectsOf(rebuilt ? LOG_SCHEMA : [...LOG_SCHEMA, ...PROJECTION_SCHEMA]).find(
    (object) => !has(object.type, object.name),
  )
  if (absent !== undefined) return yield* mismatch(userVersion, applicationId, `missing ${absent.name}`)
  return "ready" as const
})

export const objectCount = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`),
  Effect.map((rows) => rows[0]?.n ?? 0),
)
