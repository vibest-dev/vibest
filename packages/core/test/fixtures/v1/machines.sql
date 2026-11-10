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
INSERT INTO "project" VALUES ('cd027af4-3c0b-498a-9087-bf650b5372e9', '/srv/app', 'f291426f-8ca7-4fcf-9275-3a45e30d4966');
INSERT INTO "session" VALUES ('f291426f-8ca7-4fcf-9275-3a45e30d4966', 'cd027af4-3c0b-498a-9087-bf650b5372e9', NULL, NULL, 'main', 'main', 'local', '/srv/app', 0, 1794314230833, NULL);
INSERT INTO "session" VALUES ('bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'cd027af4-3c0b-498a-9087-bf650b5372e9', NULL, NULL, 'general', 'remote', 'local', '/srv/app', 0, 1794314230833, NULL);
INSERT INTO "inbox" VALUES (1, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'task', NULL, 'run the remote tests', NULL, 'delivered');
INSERT INTO "inbox" VALUES (2, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'result', 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', '<summary>Remote tests pass.</summary>', 10, 'dropped');
INSERT INTO "inbox" VALUES (3, 'f291426f-8ca7-4fcf-9275-3a45e30d4966', 'notice', NULL, 'done', NULL, 'pending');
INSERT INTO "event" VALUES (1, 1794314230833, 'f291426f-8ca7-4fcf-9275-3a45e30d4966', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p1"}');
INSERT INTO "event" VALUES (2, 1794314230833, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'peer.start', NULL, NULL, NULL, '{"peer":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","project":"22222222-2222-4222-8222-222222222222","parent":"33333333-3333-4333-8333-333333333333","reportTo":"33333333-3333-4333-8333-333333333333"}');
INSERT INTO "event" VALUES (3, 1794314230833, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (4, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'inbox.queued', NULL, NULL, 1, '{"request":"peer-spawn-1"}');
INSERT INTO "event" VALUES (5, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w2:p1"}');
INSERT INTO "event" VALUES (6, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'process.ready', 5, NULL, NULL, '{"pid":5100}');
INSERT INTO "event" VALUES (7, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'turn.start', 5, NULL, NULL, '{}');
INSERT INTO "event" VALUES (8, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'inbox.status', NULL, 7, 1, '{"to":"delivered"}');
INSERT INTO "event" VALUES (9, 1794314230834, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'turn.reported', 5, NULL, NULL, '{"harness":"pi","text":"Remote tests pass.","conversation":"conv-bbfe18c3"}');
INSERT INTO "event" VALUES (10, 1794314230835, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'turn.end', 5, 7, NULL, '{"status":"completed","report":9}');
INSERT INTO "event" VALUES (11, 1794314230835, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'inbox.queued', NULL, NULL, 2, '{}');
INSERT INTO "event" VALUES (12, 1794314230835, 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'inbox.status', NULL, NULL, 2, '{"to":"dropped"}');
INSERT INTO "event" VALUES (13, 1794314230836, 'f291426f-8ca7-4fcf-9275-3a45e30d4966', 'inbox.queued', NULL, NULL, 3, '{"request":"peer:7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f"}');
INSERT INTO "machine" VALUES ('mb', 'root@mb.example', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1794314230832, 1794314230831);
INSERT INTO "peer" VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'mac', 'mb', 1794314230832);
INSERT INTO "outbox" VALUES ('0a14986a-c188-420b-accc-40de74c3156b', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbfe18c3-f696-4aba-81c1-a447faa8e7c9', 'result', '<summary>Remote tests pass.</summary>', 1794314230835);
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
