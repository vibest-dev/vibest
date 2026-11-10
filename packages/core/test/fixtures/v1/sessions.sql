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
INSERT INTO "project" VALUES ('f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '/src/app', '52ad628b-d204-4607-891b-a2318a3537ed');
INSERT INTO "project_repository" VALUES ('f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '/src/app', 'git@example.com:acme/app.git');
INSERT INTO "session" VALUES ('55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', NULL, NULL, 'main', 'main', 'local', '/src/app', 0, 1794314230793, 1794314230818);
INSERT INTO "session" VALUES ('f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'fixer', 'local', '/w/fixer', 0, 1794314230796, NULL);
INSERT INTO "session" VALUES ('ce896a5d-5274-4cc7-8498-95d3584554c3', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'failing', 'local', '/w/failing', 0, 1794314230805, NULL);
INSERT INTO "session" VALUES ('6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'restarted', 'local', '/w/restarted', 0, 1794314230806, NULL);
INSERT INTO "session" VALUES ('ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'moved', 'local', '/w/moved', 0, 1794314230808, NULL);
INSERT INTO "session" VALUES ('e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'typed', 'local', '/w/typed', 0, 1794314230811, NULL);
INSERT INTO "session" VALUES ('0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'archived', 'local', '/w/archived', 0, 1794314230812, 1794314230814);
INSERT INTO "session" VALUES ('6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'general', 'polled', 'local', '/w/polled', 0, 1794314230815, NULL);
INSERT INTO "session" VALUES ('52ad628b-d204-4607-891b-a2318a3537ed', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', NULL, NULL, 'main', 'main', 'local', '/src/app', 0, 1794314230818, NULL);
INSERT INTO "session" VALUES ('85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'f24c0f91-8a8e-4027-b3aa-43e9a41ac097', '52ad628b-d204-4607-891b-a2318a3537ed', '52ad628b-d204-4607-891b-a2318a3537ed', 'general', 'orphan', 'local', '/w/orphan', 0, 1794314230818, NULL);
INSERT INTO "inbox" VALUES (1, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'fix the flaky test', NULL, 'delivered');
INSERT INTO "inbox" VALUES (2, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'result', 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', '<summary>All tests pass.</summary>', 10, 'delivered');
INSERT INTO "inbox" VALUES (3, 'ce896a5d-5274-4cc7-8498-95d3584554c3', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'never starts', NULL, 'delivered');
INSERT INTO "inbox" VALUES (4, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'restart me', NULL, 'delivered');
INSERT INTO "inbox" VALUES (5, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'move on limit', NULL, 'delivered');
INSERT INTO "inbox" VALUES (6, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'result', 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', '<summary>Moved and done.</summary>', 37, 'pending');
INSERT INTO "inbox" VALUES (7, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'wait for input', NULL, 'delivered');
INSERT INTO "inbox" VALUES (8, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'archive me', NULL, 'delivered');
INSERT INTO "inbox" VALUES (9, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'result', '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', '<summary>Done, archive me.</summary>', 52, 'pending');
INSERT INTO "inbox" VALUES (10, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'send', NULL, 'one more thing', NULL, 'failed');
INSERT INTO "inbox" VALUES (11, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'task', '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'report while polled', NULL, 'delivered');
INSERT INTO "inbox" VALUES (12, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'result', '6da21de3-9b62-42d7-ae5c-7c608ca53da3', '<summary>Polled result.</summary>', 64, 'pending');
INSERT INTO "inbox" VALUES (13, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'notice', 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', '', NULL, 'pending');
INSERT INTO "inbox" VALUES (14, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'task', '52ad628b-d204-4607-891b-a2318a3537ed', 'finish while the main agent is away', NULL, 'delivered');
INSERT INTO "inbox" VALUES (15, '52ad628b-d204-4607-891b-a2318a3537ed', 'result', '85d46f6a-b0d2-4fbc-b976-625dab3974cb', '<summary>Nobody listens.</summary>', 80, 'dropped');
INSERT INTO "event" VALUES (1, 1794314230793, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'process.start', NULL, NULL, NULL, '{"harness":"claude","runtime":"herdr","machine":"local","terminal":"w1:p1","pid":4000}');
INSERT INTO "event" VALUES (2, 1794314230795, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'process.conversation', 1, NULL, NULL, '{"conversation":"main-conversation"}');
INSERT INTO "event" VALUES (3, 1794314230796, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (4, 1794314230797, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'inbox.queued', NULL, NULL, 1, '{"request":"req-fixer"}');
INSERT INTO "event" VALUES (5, 1794314230797, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p2"}');
INSERT INTO "event" VALUES (6, 1794314230798, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'process.ready', 5, NULL, NULL, '{"pid":4100}');
INSERT INTO "event" VALUES (7, 1794314230798, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'turn.start', 5, NULL, NULL, '{}');
INSERT INTO "event" VALUES (8, 1794314230799, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'inbox.status', NULL, 7, 1, '{"to":"delivered"}');
INSERT INTO "event" VALUES (9, 1794314230799, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'turn.reported', 5, NULL, NULL, '{"harness":"pi","text":"All tests pass.","conversation":"conv-f359a8fd"}');
INSERT INTO "event" VALUES (10, 1794314230800, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'turn.end', 5, 7, NULL, '{"status":"completed","report":9}');
INSERT INTO "event" VALUES (11, 1794314230800, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.queued', NULL, NULL, 2, '{}');
INSERT INTO "event" VALUES (12, 1794314230802, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.status', NULL, NULL, 2, '{"to":"delivering"}');
INSERT INTO "event" VALUES (13, 1794314230803, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.status', NULL, NULL, 2, '{"to":"delivered"}');
INSERT INTO "event" VALUES (14, 1794314230805, 'ce896a5d-5274-4cc7-8498-95d3584554c3', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (15, 1794314230805, 'ce896a5d-5274-4cc7-8498-95d3584554c3', 'inbox.queued', NULL, NULL, 3, '{}');
INSERT INTO "event" VALUES (16, 1794314230806, 'ce896a5d-5274-4cc7-8498-95d3584554c3', 'process.end', 14, NULL, NULL, '{"reason":"launch_failed"}');
INSERT INTO "event" VALUES (17, 1794314230806, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (18, 1794314230806, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'inbox.queued', NULL, NULL, 4, '{}');
INSERT INTO "event" VALUES (19, 1794314230807, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p3"}');
INSERT INTO "event" VALUES (20, 1794314230807, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.ready', 19, NULL, NULL, '{"pid":4200}');
INSERT INTO "event" VALUES (21, 1794314230807, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.end', 19, NULL, NULL, '{"reason":"restart"}');
INSERT INTO "event" VALUES (22, 1794314230807, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p3"}');
INSERT INTO "event" VALUES (23, 1794314230807, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p3"}');
INSERT INTO "event" VALUES (24, 1794314230808, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.ready', 23, NULL, NULL, '{"pid":4201}');
INSERT INTO "event" VALUES (25, 1794314230808, '6f5ca0be-ee3d-41ad-b5f8-a30a8ec2cfc8', 'process.ready', 23, NULL, NULL, '{"pid":4202,"pidOnly":true}');
INSERT INTO "event" VALUES (26, 1794314230808, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (27, 1794314230808, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'inbox.queued', NULL, NULL, 5, '{}');
INSERT INTO "event" VALUES (28, 1794314230808, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p4"}');
INSERT INTO "event" VALUES (29, 1794314230808, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.ready', 28, NULL, NULL, '{"pid":4300}');
INSERT INTO "event" VALUES (30, 1794314230809, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.end', 28, NULL, NULL, '{"reason":"limited"}');
INSERT INTO "event" VALUES (31, 1794314230809, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.start', NULL, NULL, NULL, '{"harness":"claude","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (32, 1794314230809, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.start', NULL, NULL, NULL, '{"harness":"claude","runtime":"herdr","machine":"local","terminal":"w1:p5"}');
INSERT INTO "event" VALUES (33, 1794314230809, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'process.ready', 32, NULL, NULL, '{"pid":4301}');
INSERT INTO "event" VALUES (34, 1794314230809, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'turn.start', 32, NULL, NULL, '{}');
INSERT INTO "event" VALUES (35, 1794314230810, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'inbox.status', NULL, 34, 5, '{"to":"delivered"}');
INSERT INTO "event" VALUES (36, 1794314230810, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'turn.reported', 32, NULL, NULL, '{"harness":"pi","text":"Moved and done.","error":"model overloaded","conversation":"conv-ad323cf9"}');
INSERT INTO "event" VALUES (37, 1794314230810, 'ad323cf9-0f8d-4d60-a24b-88ef6dbc7484', 'turn.end', 32, 34, NULL, '{"status":"failed","report":36,"failure":{"message":"model overloaded"}}');
INSERT INTO "event" VALUES (38, 1794314230810, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.queued', NULL, NULL, 6, '{}');
INSERT INTO "event" VALUES (39, 1794314230811, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (40, 1794314230811, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'inbox.queued', NULL, NULL, 7, '{}');
INSERT INTO "event" VALUES (41, 1794314230811, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p6"}');
INSERT INTO "event" VALUES (42, 1794314230811, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'process.ready', 41, NULL, NULL, '{"pid":4400}');
INSERT INTO "event" VALUES (43, 1794314230812, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'turn.start', 41, NULL, NULL, '{"typed":"please also update the docs"}');
INSERT INTO "event" VALUES (44, 1794314230812, 'e164ee97-0e7d-4c38-96ca-39c9b89deb8f', 'turn.reported', 41, NULL, NULL, '{"harness":"pi","text":"Docs updated."}');
INSERT INTO "event" VALUES (45, 1794314230812, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (46, 1794314230812, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'inbox.queued', NULL, NULL, 8, '{}');
INSERT INTO "event" VALUES (47, 1794314230812, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p7"}');
INSERT INTO "event" VALUES (48, 1794314230812, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'process.ready', 47, NULL, NULL, '{"pid":4500}');
INSERT INTO "event" VALUES (49, 1794314230813, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'turn.start', 47, NULL, NULL, '{}');
INSERT INTO "event" VALUES (50, 1794314230813, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'inbox.status', NULL, 49, 8, '{"to":"delivered"}');
INSERT INTO "event" VALUES (51, 1794314230813, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'turn.reported', 47, NULL, NULL, '{"harness":"pi","text":"Done, archive me.","conversation":"conv-0ddb8fc6"}');
INSERT INTO "event" VALUES (52, 1794314230813, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'turn.end', 47, 49, NULL, '{"status":"completed","report":51}');
INSERT INTO "event" VALUES (53, 1794314230813, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.queued', NULL, NULL, 9, '{}');
INSERT INTO "event" VALUES (54, 1794314230814, '0ddb8fc6-9440-4da0-a36a-e2a71c6ecf7c', 'process.end', 47, NULL, NULL, '{"reason":"archived"}');
INSERT INTO "event" VALUES (55, 1794314230814, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'inbox.queued', NULL, NULL, 10, '{"request":"send-1"}');
INSERT INTO "event" VALUES (56, 1794314230815, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'inbox.status', NULL, NULL, 10, '{"to":"delivering"}');
INSERT INTO "event" VALUES (57, 1794314230815, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (58, 1794314230815, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'inbox.queued', NULL, NULL, 11, '{}');
INSERT INTO "event" VALUES (59, 1794314230815, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p8"}');
INSERT INTO "event" VALUES (60, 1794314230816, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'process.ready', 59, NULL, NULL, '{"pid":4600}');
INSERT INTO "event" VALUES (61, 1794314230816, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'turn.start', 59, NULL, NULL, '{}');
INSERT INTO "event" VALUES (62, 1794314230816, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'inbox.status', NULL, 61, 11, '{"to":"delivered"}');
INSERT INTO "event" VALUES (63, 1794314230816, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'turn.reported', 59, NULL, NULL, '{"harness":"pi","text":"Polled result.","conversation":"conv-6da21de3"}');
INSERT INTO "event" VALUES (64, 1794314230816, '6da21de3-9b62-42d7-ae5c-7c608ca53da3', 'turn.end', 59, 61, NULL, '{"status":"completed","report":63}');
INSERT INTO "event" VALUES (65, 1794314230816, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.queued', NULL, NULL, 12, '{}');
INSERT INTO "event" VALUES (66, 1794314230817, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.status', NULL, NULL, 12, '{"to":"delivering"}');
INSERT INTO "event" VALUES (67, 1794314230817, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.status', NULL, NULL, 12, '{"to":"pending"}');
INSERT INTO "event" VALUES (68, 1794314230817, 'f359a8fd-37f8-4cb2-8a40-1c1adbf89e8e', 'inbox.status', NULL, NULL, 10, '{"to":"failed"}');
INSERT INTO "event" VALUES (69, 1794314230817, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'inbox.queued', NULL, NULL, 13, '{}');
INSERT INTO "event" VALUES (70, 1794314230818, '55f42361-8d1d-4333-ab68-9aa8c8ffccff', 'process.end', 1, NULL, NULL, '{"reason":"archived"}');
INSERT INTO "event" VALUES (71, 1794314230818, '52ad628b-d204-4607-891b-a2318a3537ed', 'process.start', NULL, NULL, NULL, '{"harness":"claude","runtime":"herdr","machine":"local","terminal":"w1:p1"}');
INSERT INTO "event" VALUES (72, 1794314230818, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":""}');
INSERT INTO "event" VALUES (73, 1794314230819, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'inbox.queued', NULL, NULL, 14, '{}');
INSERT INTO "event" VALUES (74, 1794314230819, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'process.start', NULL, NULL, NULL, '{"harness":"pi","runtime":"herdr","machine":"local","terminal":"w1:p9"}');
INSERT INTO "event" VALUES (75, 1794314230819, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'process.ready', 74, NULL, NULL, '{"pid":4700}');
INSERT INTO "event" VALUES (76, 1794314230819, '52ad628b-d204-4607-891b-a2318a3537ed', 'process.end', 71, NULL, NULL, '{"reason":"exited"}');
INSERT INTO "event" VALUES (77, 1794314230819, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'turn.start', 74, NULL, NULL, '{}');
INSERT INTO "event" VALUES (78, 1794314230820, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'inbox.status', NULL, 77, 14, '{"to":"delivered"}');
INSERT INTO "event" VALUES (79, 1794314230820, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'turn.reported', 74, NULL, NULL, '{"harness":"pi","text":"Nobody listens.","conversation":"conv-85d46f6a"}');
INSERT INTO "event" VALUES (80, 1794314230820, '85d46f6a-b0d2-4fbc-b976-625dab3974cb', 'turn.end', 74, 77, NULL, '{"status":"completed","report":79}');
INSERT INTO "event" VALUES (81, 1794314230820, '52ad628b-d204-4607-891b-a2318a3537ed', 'inbox.queued', NULL, NULL, 15, '{}');
INSERT INTO "event" VALUES (82, 1794314230820, '52ad628b-d204-4607-891b-a2318a3537ed', 'inbox.status', NULL, NULL, 15, '{"to":"dropped"}');
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
