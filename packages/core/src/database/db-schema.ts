import { shellQuote } from "@vibest/schema/layout"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

export const APPLICATION_ID = 0x76696265

export const MIGRATION_TABLE = "migration"

export const APPEND_ONLY_TRIGGER = `CREATE TRIGGER event_no_update BEFORE UPDATE ON event
    BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`

export const LOG_SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  `CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT`,
  `CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT`,
  `CREATE TABLE event (
    position     INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE,
    aggregate_id TEXT    NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    created      INTEGER NOT NULL,
    type         TEXT    NOT NULL,
    data         TEXT    NOT NULL,
    UNIQUE (aggregate_id, seq)
  ) STRICT`,
  `CREATE INDEX event_aggregate_type_seq ON event (aggregate_id, type, seq)`,
  APPEND_ONLY_TRIGGER,
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
  unknownMigration: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    const file = this.file ?? "vibest.db"

    if (this.unknownMigration !== undefined)
      return `${file} was migrated by a newer vibest (migration ${this.unknownMigration}): run vibest update`
    const aside = `To start empty, with vibestd stopped, move it aside with its -wal and -shm files: for f in ${["", "-wal", "-shm"].map((suffix) => shellQuote(file + suffix)).join(" ")}; do [ -e "$f" ] && mv "$f" "$f.old"; done (the sessions, results and queued messages it holds are lost; agents still running keep running, but vibest no longer knows them)`

    if (this.older)
      return `${file} is from an older vibest (its tables are the shape from before this release). ${aside}`
    const id = `0x${(this.applicationId >>> 0).toString(16)}`
    const extra = this.detail === undefined ? "" : `, ${this.detail}`

    return `${file} is not this vibest's schema (application_id ${id}, v${this.version}${extra}). ${aside}`
  }
}

export const mismatch = (version: number, applicationId: number, detail?: string) =>
  new SchemaMismatch({ version, applicationId, ...(detail !== undefined && { detail }) })

export const ledgerOf = (sql: SqlClient.SqlClient) =>
  sql<{ value: string }>`SELECT value FROM kv WHERE key = 'ledger'`.pipe(Effect.map((rows) => rows[0]?.value))

export const inspectSchema = (knownMigrations: ReadonlySet<string> = new Set()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe<{ type: string; name: string }>("SELECT type, name FROM sqlite_master")

    if (rows.length === 0) return "empty" as const
    const applicationId = (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0
    const userVersion = (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0
    const has = (type: string, name: string) => rows.some((row) => row.type === type && row.name === name)

    if (applicationId !== APPLICATION_ID) return yield* mismatch(userVersion, applicationId)

    if (!has("table", MIGRATION_TABLE))
      return yield* new SchemaMismatch({ version: userVersion, applicationId, older: true })

    if (has("table", "meta") || !has("table", "event_sequence") || !has("table", "kv"))
      return yield* new SchemaMismatch({ version: userVersion, applicationId, older: true })

    const absent = objectsOf([...LOG_SCHEMA, ...PROJECTION_SCHEMA]).find((object) => !has(object.type, object.name))

    if (absent !== undefined) return yield* mismatch(userVersion, applicationId, `missing ${absent.name}`)

    const applied = yield* sql<{ id: string }>`SELECT id FROM migration`
    const unknown = applied.find((row) => !knownMigrations.has(row.id))

    if (unknown !== undefined)
      return yield* new SchemaMismatch({ version: userVersion, applicationId, unknownMigration: unknown.id })

    return "ready" as const
  })

export const objectCount = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`),
  Effect.map((rows) => rows[0]?.n ?? 0),
)

export const PROJECTION_SCHEMA = [
  `CREATE TABLE project (
    id        TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory TEXT UNIQUE
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
    origin_remote         TEXT,
    origin_project        TEXT,
    origin_session        TEXT,
    created_at            INTEGER NOT NULL,
    ended_at              INTEGER,
    process_id            INTEGER,
    active_at             INTEGER,
    message_id            INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE INDEX session_live ON session (directory) WHERE ended_at IS NULL`,
  `CREATE INDEX session_origin ON session (origin_remote, origin_project) WHERE origin_remote IS NOT NULL`,
  `CREATE TABLE session_edge (
    from_session_id TEXT NOT NULL,
    to_remote_id    TEXT NOT NULL DEFAULT '',
    to_session_id   TEXT NOT NULL,
    PRIMARY KEY (from_session_id, to_remote_id, to_session_id)
  ) STRICT`,
  `CREATE INDEX session_edge_to ON session_edge (to_remote_id, to_session_id)`,
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
    harness_session_id   TEXT,
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
    booked_at    INTEGER NOT NULL,
    started_at   INTEGER,
    outcome      TEXT CHECK (outcome IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),
    failure      TEXT,
    failure_kind TEXT CHECK (failure_kind IN ('limit')),
    reply        TEXT,
    ended_at     INTEGER,
    owner        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, id)
  ) STRICT`,
  `CREATE UNIQUE INDEX execution_open ON execution (session_id) WHERE owner = 1`,
  `CREATE TABLE inbox (
    recipient_session_id   TEXT    NOT NULL,
    id                     INTEGER NOT NULL,
    sender_type            TEXT    NOT NULL CHECK (sender_type IN ('agent', 'plugin', 'vibest', 'user')),
    sender_session_id      TEXT,
    sender_agent           TEXT,
    sender_title           TEXT,
    sender_machine         TEXT,
    sender_plugin          TEXT,
    sender_key             TEXT    NOT NULL,
    about_session_id       TEXT,
    content                TEXT    NOT NULL,
    request_id             TEXT,
    transfer_id            TEXT,
    status                 TEXT    NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    sender_execution_id    INTEGER,
    recipient_execution_id INTEGER,
    PRIMARY KEY (recipient_session_id, id)
  ) STRICT`,
  `CREATE INDEX inbox_status ON inbox (status, recipient_session_id)`,
  `CREATE INDEX inbox_sender ON inbox (sender_session_id) WHERE sender_session_id IS NOT NULL`,
  `CREATE INDEX inbox_about ON inbox (about_session_id) WHERE about_session_id IS NOT NULL`,
  `CREATE INDEX inbox_recipient_execution ON inbox (recipient_session_id, recipient_execution_id) WHERE recipient_execution_id IS NOT NULL`,
  `CREATE UNIQUE INDEX inbox_request ON inbox (sender_key, request_id) WHERE request_id IS NOT NULL`,
  `CREATE UNIQUE INDEX inbox_transfer ON inbox (transfer_id) WHERE transfer_id IS NOT NULL`,
  `CREATE TABLE machine (
    name         TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    remote_id    TEXT NOT NULL UNIQUE CHECK (length(remote_id) = 36),
    connected_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE remote (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    name         TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE outbox (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    seq          INTEGER NOT NULL,
    remote_id    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    recipient    TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('send', 'notice')),
    content      TEXT NOT NULL,
    from_session TEXT,
    from_agent   TEXT,
    from_title   TEXT,
    from_machine TEXT,
    execution_id INTEGER,
    created_at   INTEGER NOT NULL,
    acked_at     INTEGER
  ) STRICT`,
  `CREATE INDEX outbox_remote ON outbox (remote_id, seq) WHERE acked_at IS NULL`,
  `CREATE INDEX outbox_session ON outbox (session_id)`,
]

export const PROJECTION_TABLES = {
  project: "id",
  project_repository: "path",
  session: "id",
  session_edge: "from_session_id, to_remote_id, to_session_id",
  process: "session_id, id",
  execution: "session_id, id",
  inbox: "recipient_session_id, id",
  machine: "name",
  remote: "id",
  outbox: "id",
} as const
