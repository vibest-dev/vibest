// main's schema DDL, copied verbatim from vibest-dev/vibest 12f3340 (v0.0.1-beta.17) packages/core/src/db.ts SCHEMA, with
// APPLICATION_ID (0x76696265) and SCHEMA_VERSION (1) written out: a file main created, for the test that opens one.
export const MAIN_SCHEMA = [
  `PRAGMA application_id = 1986617957`,
  `PRAGMA user_version = 1`,
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
