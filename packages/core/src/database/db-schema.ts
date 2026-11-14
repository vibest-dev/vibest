import { CATALOG_VERSION } from "@vibest/schema/event"
import { shellQuote } from "@vibest/schema/layout"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

export const APPLICATION_ID = 0x76696265

export const MIGRATION_TABLE = "migration"

export const LOG_SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `CREATE TABLE event (
    position  INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate TEXT    NOT NULL,
    seq       INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    type      TEXT    NOT NULL,
    data      TEXT    NOT NULL,
    UNIQUE (aggregate, seq)
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
  oldEvents: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    const file = this.file ?? "vibest.db"
    if (this.catalog !== undefined)
      return `${file} was written by a newer vibest (event catalog ${this.catalog}, this vibest knows ${CATALOG_VERSION}): run vibest update`
    const aside = `To start empty, with vibestd stopped, move it aside with its -wal and -shm files: for f in ${["", "-wal", "-shm"].map((suffix) => shellQuote(file + suffix)).join(" ")}; do [ -e "$f" ] && mv "$f" "$f.old"; done (the sessions, results and queued messages it holds are lost; agents still running keep running, but vibest no longer knows them)`
    if (this.oldEvents)
      return `${file} is from an older vibest (its event log is the shape from before per-aggregate events): see "The event log is per aggregate" in the vibest CHANGELOG. ${aside}`
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

export const setMeta = (sql: SqlClient.SqlClient, key: "catalog" | "projection", value: number) =>
  sql`INSERT INTO meta (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`

export const ledgerOf = (sql: SqlClient.SqlClient) =>
  sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`.pipe(Effect.map((rows) => rows[0]?.value))

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
  if (catalog < CATALOG_VERSION || (yield* ledgerOf(sql)) === undefined)
    return yield* new SchemaMismatch({ version: userVersion, applicationId, oldEvents: true })
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

export const PROJECTION_VERSION = 8

export const PROJECTION_SCHEMA = [
  `CREATE TABLE project (
    id               TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory        TEXT UNIQUE,
    entry_session_id TEXT
  ) STRICT`,
  `CREATE TABLE project_repository (
    project_id TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    remote_url TEXT
  ) STRICT`,
  `CREATE INDEX project_repository_project ON project_repository (project_id)`,
  `CREATE TABLE session (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    parent_session_id     TEXT,
    agent                 TEXT NOT NULL,
    name                  TEXT NOT NULL,
    directory             TEXT NOT NULL,
    origin_peer           TEXT,
    origin_project        TEXT,
    origin_session        TEXT,
    created_at            INTEGER NOT NULL,
    ended_at              INTEGER,
    process_id            INTEGER,
    active_at             INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE INDEX session_live ON session (directory) WHERE ended_at IS NULL`,
  `CREATE INDEX session_origin ON session (origin_peer, origin_project) WHERE origin_peer IS NOT NULL`,
  `CREATE TABLE process (
    session_id           TEXT NOT NULL,
    id                   INTEGER NOT NULL,
    harness              TEXT NOT NULL,
    provider             TEXT,
    model                TEXT,
    routing              TEXT,
    runtime              TEXT NOT NULL,
    terminal             TEXT,
    pid                  INTEGER,
    integration_version  TEXT,
    integration_protocol INTEGER,
    conversation         TEXT,
    started_at           INTEGER NOT NULL,
    placed_at            INTEGER,
    ready_at             INTEGER,
    ended_at             INTEGER,
    end_reason           TEXT,
    PRIMARY KEY (session_id, id)
  ) STRICT`,
  `CREATE UNIQUE INDEX process_live ON process (session_id) WHERE ended_at IS NULL`,
  `CREATE INDEX process_terminal ON process (runtime, terminal) WHERE ended_at IS NULL AND terminal IS NOT NULL`,
  `CREATE TABLE execution (
    session_id   TEXT NOT NULL,
    id           INTEGER NOT NULL,
    process_id   INTEGER,
    typed        TEXT,
    started_at   INTEGER NOT NULL,
    accepted_at  INTEGER,
    outcome      TEXT CHECK (outcome IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),
    failure      TEXT,
    failure_kind TEXT CHECK (failure_kind IN ('limit')),
    reply        TEXT,
    ended_at     INTEGER,
    PRIMARY KEY (session_id, id)
  ) STRICT`,
  `CREATE UNIQUE INDEX execution_open ON execution (session_id) WHERE outcome IS NULL`,
  `CREATE TABLE inbox (
    session_id        TEXT    NOT NULL,
    id                INTEGER NOT NULL,
    sender_session_id TEXT,
    kind              TEXT    NOT NULL CHECK (kind IN ('task', 'send', 'notice')),
    content           TEXT    NOT NULL,
    request           TEXT,
    peer_item         TEXT,
    status            TEXT    NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    execution_id      INTEGER,
    PRIMARY KEY (session_id, id)
  ) STRICT`,
  `CREATE INDEX inbox_status ON inbox (status, session_id)`,
  `CREATE INDEX inbox_kind ON inbox (session_id, kind, id)`,
  `CREATE INDEX inbox_execution ON inbox (session_id, execution_id) WHERE execution_id IS NOT NULL`,
  `CREATE INDEX inbox_request ON inbox (request) WHERE request IS NOT NULL`,
  `CREATE UNIQUE INDEX inbox_peer_item ON inbox (peer_item) WHERE peer_item IS NOT NULL`,
  `CREATE TABLE machine (
    name         TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    vibestd_id   TEXT NOT NULL UNIQUE CHECK (length(vibestd_id) = 36),
    connected_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE peer (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    name         TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE outbox (
    id         TEXT PRIMARY KEY CHECK (length(id) = 36),
    seq        INTEGER NOT NULL,
    peer_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    recipient  TEXT,
    kind       TEXT NOT NULL CHECK (kind IN ('send', 'notice')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX outbox_peer ON outbox (peer_id, seq)`,
  `CREATE INDEX outbox_session ON outbox (session_id)`,
]

export const PROJECTION_TABLES = {
  project: "id",
  project_repository: "path",
  session: "id",
  process: "session_id, id",
  execution: "session_id, id",
  inbox: "session_id, id",
  machine: "name",
  peer: "id",
  outbox: "id",
} as const
