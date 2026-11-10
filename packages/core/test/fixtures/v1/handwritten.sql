PRAGMA application_id = 1986617957;
PRAGMA user_version = 1;
CREATE TABLE project (
    id               TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory        TEXT UNIQUE,
    entry_session_id TEXT REFERENCES session (id)
  ) STRICT;
CREATE TABLE project_repository (
    project_id TEXT NOT NULL REFERENCES project (id),
    path       TEXT NOT NULL UNIQUE,
    remote_url TEXT
  ) STRICT;
CREATE TABLE session (
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
  ) STRICT;
CREATE TABLE inbox (
    id                   INTEGER PRIMARY KEY,
    recipient_session_id TEXT REFERENCES session (id),
    kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
    sender_session_id    TEXT REFERENCES session (id),
    content              TEXT NOT NULL,
    result_event_id      INTEGER REFERENCES event (id),
    status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    CHECK ((kind = 'result') = (result_event_id IS NOT NULL)),
    CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)
  ) STRICT;
CREATE TABLE event (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    session_id TEXT NOT NULL REFERENCES session (id),
    type       TEXT NOT NULL,
    process_id INTEGER REFERENCES event (id),
    turn_id    INTEGER REFERENCES event (id),
    inbox_id   INTEGER REFERENCES inbox (id),
    data       TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
CREATE TABLE machine (
    name         TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    vibestd_id   TEXT NOT NULL UNIQUE CHECK (length(vibestd_id) = 36),
    connected_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT;
CREATE TABLE peer (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    name         TEXT NOT NULL,
    calls_me     TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE outbox (
    id         TEXT PRIMARY KEY CHECK (length(id) = 36),
    peer_id    TEXT NOT NULL REFERENCES peer (id),
    session_id TEXT NOT NULL REFERENCES session (id),
    kind       TEXT NOT NULL CHECK (kind IN ('result', 'notice')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
INSERT INTO "project" VALUES ('772ae6ec-c81a-420f-abe1-11d9593d6b6e', '/w/old', 'fe00640f-e031-424e-bec0-f6d61c820585');
INSERT INTO "session" VALUES ('fe00640f-e031-424e-bec0-f6d61c820585', '772ae6ec-c81a-420f-abe1-11d9593d6b6e', NULL, NULL, 'main', 'main', 'local', '/w/old', 0, 1794314230843, NULL);
INSERT INTO "session" VALUES ('56a35686-a00d-4463-a5be-69c0cf9b19b5', '772ae6ec-c81a-420f-abe1-11d9593d6b6e', 'fe00640f-e031-424e-bec0-f6d61c820585', 'fe00640f-e031-424e-bec0-f6d61c820585', 'general', 'old', 'local', '/w/old', 0, 1794314230844, NULL);
INSERT INTO "inbox" VALUES (1, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'task', 'fe00640f-e031-424e-bec0-f6d61c820585', 'an old result with output', NULL, 'delivered');
INSERT INTO "inbox" VALUES (2, 'fe00640f-e031-424e-bec0-f6d61c820585', 'result', '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'old result', 8, 'pending');
INSERT INTO "inbox" VALUES (3, 'fe00640f-e031-424e-bec0-f6d61c820585', 'notice', NULL, 'twice', NULL, 'pending');
INSERT INTO "inbox" VALUES (4, 'fe00640f-e031-424e-bec0-f6d61c820585', 'notice', NULL, 'twice', NULL, 'pending');
INSERT INTO "event" VALUES (1, 1794314230843, 'fe00640f-e031-424e-bec0-f6d61c820585', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p1"}');
INSERT INTO "event" VALUES (2, 1794314230844, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (3, 1794314230844, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'inbox.queued', NULL, NULL, 1, '{}');
INSERT INTO "event" VALUES (4, 1794314230844, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w3:p1"}');
INSERT INTO "event" VALUES (5, 1794314230845, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'process.ready', 4, NULL, NULL, '{"pid":6100}');
INSERT INTO "event" VALUES (6, 1794314230845, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'process.ready', 4, NULL, NULL, '{"pid":6101,"pidOnly":true}');
INSERT INTO "event" VALUES (7, 1794314230845, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'turn.start', 4, NULL, NULL, '{"by":"delivery"}');
INSERT INTO "event" VALUES (8, 1794314230846, '56a35686-a00d-4463-a5be-69c0cf9b19b5', 'turn.end', 4, 7, NULL, '{"status":"completed","output":"Old output.\nsecond line"}');
INSERT INTO "event" VALUES (9, 1794314230847, 'fe00640f-e031-424e-bec0-f6d61c820585', 'inbox.queued', NULL, NULL, 2, '{}');
INSERT INTO "event" VALUES (10, 1794314230848, 'fe00640f-e031-424e-bec0-f6d61c820585', 'inbox.queued', NULL, NULL, 3, '{"request":"peer:5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"}');
INSERT INTO "event" VALUES (11, 1794314230849, 'fe00640f-e031-424e-bec0-f6d61c820585', 'inbox.queued', NULL, NULL, 4, '{"request":"peer:5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"}');
CREATE INDEX project_repository_project ON project_repository (project_id);
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent ON session (parent_session_id);
CREATE INDEX session_live ON session (machine, directory) WHERE ended_at IS NULL;
CREATE INDEX inbox_status ON inbox (status, recipient_session_id);
CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id);
CREATE INDEX inbox_result ON inbox (result_event_id) WHERE result_event_id IS NOT NULL;
CREATE INDEX event_session ON event (session_id, type, id);
CREATE INDEX event_process ON event (process_id, type, id) WHERE process_id IS NOT NULL;
CREATE INDEX event_turn ON event (turn_id, type) WHERE turn_id IS NOT NULL;
CREATE INDEX event_inbox ON event (inbox_id) WHERE inbox_id IS NOT NULL;
CREATE UNIQUE INDEX event_process_end ON event (process_id) WHERE type = 'process.end';
CREATE UNIQUE INDEX event_turn_end ON event (turn_id) WHERE type = 'turn.end';
CREATE INDEX event_terminal ON event (json_extract(data, '$.runtime'), json_extract(data, '$.machine'),
    json_extract(data, '$.terminal')) WHERE type = 'process.start';
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
    BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE INDEX outbox_peer ON outbox (peer_id, created_at);
CREATE INDEX outbox_session ON outbox (session_id);
