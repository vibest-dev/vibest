import { shellQuote } from "@vibest/schema/layout"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { REMOTE_TABLES } from "./db-remote.ts"

export const APPLICATION_ID = 0x76696265
export const SCHEMA_VERSION = 1

export const SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `PRAGMA user_version = ${SCHEMA_VERSION}`,
  `CREATE TABLE project (
    id               TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory        TEXT UNIQUE,
    entry_session_id TEXT REFERENCES session (id)
  ) STRICT`,
  `CREATE TABLE project_repository (
    project_id TEXT NOT NULL REFERENCES project (id),
    path       TEXT NOT NULL UNIQUE,
    remote_url TEXT
  ) STRICT`,
  `CREATE INDEX project_repository_project ON project_repository (project_id)`,
  `CREATE TABLE session (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES project (id),
    parent_session_id     TEXT REFERENCES session (id),
    report_to_session_id  TEXT REFERENCES session (id),
    role                  TEXT NOT NULL,
    name                  TEXT NOT NULL,
    machine               TEXT NOT NULL,
    directory             TEXT NOT NULL,
    archive_on_completion INTEGER NOT NULL DEFAULT 0 CHECK (archive_on_completion IN (0, 1)),
    created_at            INTEGER NOT NULL,
    ended_at              INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE INDEX session_live ON session (machine, directory) WHERE ended_at IS NULL`,
  `CREATE TABLE inbox (
    id                   INTEGER PRIMARY KEY,
    recipient_session_id TEXT REFERENCES session (id),
    kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
    sender_session_id    TEXT REFERENCES session (id),
    content              TEXT NOT NULL,
    result_event_id      INTEGER REFERENCES event (id),
    status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    CHECK ((kind = 'result') = (result_event_id IS NOT NULL)),
    CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX inbox_status ON inbox (status, recipient_session_id)`,
  `CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id)`,
  `CREATE INDEX inbox_result ON inbox (result_event_id) WHERE result_event_id IS NOT NULL`,
  `CREATE TABLE event (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    session_id TEXT NOT NULL REFERENCES session (id),
    type       TEXT NOT NULL,
    process_id INTEGER REFERENCES event (id),
    turn_id    INTEGER REFERENCES event (id),
    inbox_id   INTEGER REFERENCES inbox (id),
    data       TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,
  `CREATE INDEX event_session ON event (session_id, type, id)`,
  `CREATE INDEX event_process ON event (process_id, type, id) WHERE process_id IS NOT NULL`,
  `CREATE INDEX event_turn ON event (turn_id, type) WHERE turn_id IS NOT NULL`,
  `CREATE INDEX event_inbox ON event (inbox_id) WHERE inbox_id IS NOT NULL`,
  `CREATE UNIQUE INDEX event_process_end ON event (process_id) WHERE type = 'process.end'`,
  `CREATE UNIQUE INDEX event_turn_end ON event (turn_id) WHERE type = 'turn.end'`,
  `CREATE INDEX event_terminal ON event (json_extract(data, '$.runtime'), json_extract(data, '$.machine'),
    json_extract(data, '$.terminal')) WHERE type = 'process.start'`,
  `CREATE TRIGGER event_no_update BEFORE UPDATE ON event
    BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
]

export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
  version: Schema.Number,
  applicationId: Schema.Number,
  detail: Schema.optional(Schema.String),
  older: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    const file = this.file ?? "vibest.db"
    const aside = `vibest never migrates a database. To start empty, with vibestd stopped, move it aside with its -wal and -shm files: for f in ${["", "-wal", "-shm"].map((suffix) => shellQuote(file + suffix)).join(" ")}; do [ -e "$f" ] && mv "$f" "$f.old"; done (the sessions, results and queued messages it holds are lost; agents still running keep running, but vibest no longer knows them)`
    if (this.older)
      return `${file} is from an older vibest (its tables are the shape from before this release). ${aside}`
    const id = `0x${(this.applicationId >>> 0).toString(16)}`
    const extra = this.detail === undefined ? "" : `, ${this.detail}`
    return `${file} is not this vibest's schema (application_id ${id}, v${this.version}${extra}). ${aside}`
  }
}

export const REQUIRED = SCHEMA.flatMap((statement) => {
  const found = /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/.exec(statement)
  return found ? [{ type: found[1]!.toLowerCase(), name: found[2]! }] : []
})

export const mismatch = (version: number, applicationId: number, detail?: string) =>
  new SchemaMismatch({ version, applicationId, ...(detail === undefined ? {} : { detail }) })

export const inspectSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql.unsafe<{ type: string; name: string }>("SELECT type, name FROM sqlite_master")
  if (rows.length === 0) return "empty" as const
  const applicationId = (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0
  const userVersion = (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0
  const missing = REQUIRED.find((object) => !rows.some((row) => row.type === object.type && row.name === object.name))
  if (
    applicationId === APPLICATION_ID &&
    userVersion === SCHEMA_VERSION &&
    !rows.some((row) => row.type === "table" && row.name === "event")
  )
    return yield* new SchemaMismatch({ version: userVersion, applicationId, older: true })
  if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION || missing !== undefined) {
    return yield* mismatch(
      userVersion,
      applicationId,
      missing === undefined || userVersion !== SCHEMA_VERSION ? undefined : `missing ${missing.name}`,
    )
  }
  return "ready" as const
})

export const objectCount = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`),
  Effect.map((rows) => rows[0]?.n ?? 0),
)

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if ((yield* inspectSchema) === "empty") {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* objectCount) === 0) for (const statement of SCHEMA) yield* sql.unsafe(statement)
      }),
    )
  }
  if ((yield* inspectSchema) !== "ready") return yield* mismatch(0, 0, "empty after install")
  yield* sql.withTransaction(Effect.forEach(REMOTE_TABLES, (statement) => sql.unsafe(statement), { discard: true }))
})
