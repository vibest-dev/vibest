# Schema

Status: version 2 is the agreed design and is planned; nothing below runs yet. vibestd today runs version 1
(`user_version = 1`, in `packages/core/src/db.ts`): tables `project` (with `main_session_id`), `session` (with a
`metadata` JSON column), `inbox` (a recipient session is required) and `message` (one row per round). Version 2
replaces `message` and `session.metadata` with an append-only `event` table, and adds the routing columns of the
engine (architecture.md §1).

Four SQLite tables, one purpose each:

- `project`: a Project, and its optional entry session.
- `session`: one agent's identity and conversation, described by an agent definition; who spawned it and where its
  results go.
- `inbox`: text for a session or for the user, and whether it was delivered. `status` is its only changing column.
- `event`: what vibest saw happen to a session, in order: its processes, its turns, and its inbox rows. Rows are
  only appended.

## Rules

- Record only facts vibest alone knows and cannot read back later: decisions, events it saw, inputs, times. Read
  git, files, the runtime and the configuration when they are needed.
- A JSON value is written once and never changed. The event table is append-only.
- `--env` values are never stored: not in the database, logs or telemetry. They reach the terminal only when it
  opens. An in-place restart or a harness change in the same pane keeps them (the pane's shell has them); a new
  terminal does not, and the user passes `--env` again.
- No peer relation and no worktree table. A session records its machine and directory. A directory under the vibest
  worktrees root is one vibest made; a name is reserved by an atomic `mkdir`. It can be removed when no other live
  session uses the same (machine, directory), then after the lsof and git checks.
- Branch and pushed state are rendered into the result text when the result inbox row is created; no table holds
  them.
- Results and reports reach the database through vibestd, never through files under `results/` and `reports/`.
- Engine telemetry (lock waits, retries, hook timings) goes to logs and OpenTelemetry, not the event table.
- Leases, the restarting mark, running work and per-session locks are memory only (see Memory).
- Agent capabilities (spawn, message, tools) come from the agent definition in configuration, not from the
  database. A routing decision is not recorded separately: it is the recipient of the result row.
- Times are epoch milliseconds. Session ids are 8 hex characters.

## DDL

```sql
PRAGMA application_id = 1986618981;  -- "vibe"
PRAGMA user_version = 2;

CREATE TABLE project (
  id               INTEGER PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,              -- projectRoot key; not a path
  entry_session_id TEXT REFERENCES session (id)       -- what a bare `vibest` reopens, and the fallback recipient; not identity
) STRICT;

CREATE TABLE session (
  id                    TEXT PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES project (id),
  parent_session_id     TEXT REFERENCES session (id), -- who spawned it; null: the user. Rights and placement, never routing
  report_to_session_id  TEXT REFERENCES session (id), -- where its results go; written at spawn, never changed; null: the user
  role                  TEXT NOT NULL,                -- agent definition name (open set)
  name                  TEXT NOT NULL,
  machine               TEXT NOT NULL,
  directory             TEXT NOT NULL,
  archive_on_completion INTEGER NOT NULL DEFAULT 0 CHECK (archive_on_completion IN (0, 1)),
  created_at            INTEGER NOT NULL,
  ended_at              INTEGER                       -- archived, or replaced by vibest --new
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent  ON session (parent_session_id);
CREATE INDEX session_live    ON session (machine, directory) WHERE ended_at IS NULL;

CREATE TABLE inbox (                                  -- the delivery queue; status is its only mutable column
  id                   INTEGER PRIMARY KEY,
  recipient_session_id TEXT REFERENCES session (id),  -- null: the user
  kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'result', 'notice')),
  sender_session_id    TEXT REFERENCES session (id),  -- null: the user; notice: the session it is about
  content              TEXT NOT NULL,                 -- written once; result: the rendered result text with branch and pushed
  result_event_id      INTEGER REFERENCES event (id), -- result: the turn.end it reports
  status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
  CHECK ((kind = 'result') = (result_event_id IS NOT NULL)),
  CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)  -- a row for the user takes its project from its sender
) STRICT;
CREATE INDEX inbox_status    ON inbox (status, recipient_session_id);   -- full index on purpose: a partial IN (...) index is not used for status = 'pending'
CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id);
CREATE INDEX inbox_result    ON inbox (result_event_id) WHERE result_event_id IS NOT NULL;
CREATE INDEX inbox_user      ON inbox (sender_session_id, id) WHERE recipient_session_id IS NULL;

CREATE TABLE event (                                  -- append-only
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES session (id),
  type       TEXT NOT NULL,
  process_id INTEGER REFERENCES event (id),           -- the process.start it belongs to (null on process.start itself)
  turn_id    INTEGER REFERENCES event (id),           -- the turn.start it belongs to
  inbox_id   INTEGER REFERENCES inbox (id),
  data       TEXT NOT NULL DEFAULT '{}'               -- typed per type (Effect Schema union, no version field); written once
) STRICT;
CREATE INDEX event_session ON event (session_id, type, id);
CREATE INDEX event_process ON event (process_id, type, id) WHERE process_id IS NOT NULL;
CREATE INDEX event_turn    ON event (turn_id, type) WHERE turn_id IS NOT NULL;
CREATE INDEX event_inbox   ON event (inbox_id) WHERE inbox_id IS NOT NULL;
CREATE UNIQUE INDEX event_process_end ON event (process_id) WHERE type = 'process.end';
CREATE UNIQUE INDEX event_turn_end    ON event (turn_id)    WHERE type = 'turn.end';
CREATE INDEX event_terminal ON event (json_extract(data, '$.runtime'), json_extract(data, '$.machine'),
  json_extract(data, '$.terminal')) WHERE type = 'process.start';

CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
```

No other triggers: one live process and one open turn per session are enforced in code, under the per-session
lock, with a check inside the transaction before the insert. The two unique indexes make each process and each
turn end at most once.

## Inbox

An inbox row is text for one recipient: a session, or the user (`recipient_session_id` null).

| `kind`   | What it is                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `task`   | the first input of a session, from whoever spawned it                                                                   |
| `send`   | a message from the user or a session; a session's report to its reply target is a `send` too                            |
| `result` | a turn's result, rendered once from its `turn.end` (`result_event_id`), for the reply target                            |
| `notice` | something vibest tells the recipient about a session (`sender_session_id`): blocked, not started, undelivered, archived |

- Delivery scans rows with `recipient_session_id IS NOT NULL`. A row for the user is marked delivered once
  `vibest inbox` has shown it; `inbox_user` finds them per sending session.
- The recipient of a result row is the routing decision of `replyTo(turn)` (architecture.md §1): (1) the sessions
  that sent the `task` and `send` rows the turn consumed; else (2) `report_to_session_id`; else (3) the user, when a
  row from the user opened the turn. (4) A turn woken by a `result` or `notice`, or opened by text typed in the pane,
  goes to `report_to_session_id` when it is set and makes no result row when it is not. An ended recipient falls
  back to the entry session (if live and not the session itself), then to the user; the `agent.result` hook may
  rewrite the recipients. A `notice` goes to `report_to_session_id`, then the entry session, then the user, and the
  `agent.notice` hook may rewrite them.

## Event types (data fields)

| type                 | link columns        | data                                                                                                                                                          |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| process.start        | -                   | harness (an open string), provider?, model?, routing? (the plugins' decision record), runtime, machine, terminal, resume? (the conversation id it resumes)    |
| process.ready        | process_id          | pid, conversation?, integration {version, protocol}; may repeat after a plugin reload                                                                         |
| process.conversation | process_id          | conversation (a new conversation id: after /clear, or Pi at its first agent_end)                                                                              |
| process.end          | process_id          | reason: exited, limited, restart, move, archived (also for vibest --new), launch_failed; detail?                                                              |
| turn.start           | process_id          | by: delivery or typed; typed? (the text typed into the pane); resumes? (turn id, after a harness change or restart)                                           |
| turn.end             | process_id, turn_id | status: completed, failed, interrupted, lost, not_started; output?, failure? {kind: limited, auth, other; message}, cause?: interrupt, limited, restart, move |
| inbox.queued         | inbox_id            | kind (the queue time is `at`)                                                                                                                                 |
| inbox.status         | inbox_id, turn_id?  | from, to, reason? (recovered, lease_ended, absent); on to = delivered, turn_id is the turn that consumed it                                                   |

A turn's input is its typed text, or the inbox rows with an `inbox.status` event `to = delivered` and `turn_id` =
that turn. The integration's `turn.start` names the inbox rows it consumed, so a delivered row always has its turn.

## Hot paths

- Pending scan every few seconds: inbox `WHERE status = 'pending' AND recipient_session_id IS NOT NULL` through
  `inbox_status`; the cost does not grow with history.
- Open turn of a session: the latest `turn.start` (`event_session`, `ORDER BY id DESC LIMIT 1`), then check it has
  no `turn.end` (`event_turn`). Never an outer `NOT EXISTS` over all starts: it scans the whole history.
- Live process and pid: the same shape with `process.start`, then the latest `process.ready` of that process.
- Entry session by terminal: the `event_terminal` expression index, joined to `project.entry_session_id`, no
  `process.end`.
- Usage-limit attempts: `process.end` with reason `limited` of the session, joined to its `process.start` for
  harness and provider.
- In-place restart after an update: live sessions (`session_live`), the latest live process, its latest
  `process.ready`, compare the integration. Order: restarting mark in memory, SIGTERM, then `turn.end`
  (interrupted, cause restart) and `process.end` (restart), then the new `process.start`. A refused SIGTERM writes
  nothing.
- `ls`: sessions by project, the first `task` row, the latest turn and live process as above, and the unread rows
  for the user. `result`: the latest `turn.end` with its result row.

## Memory

- Live status: from the integration's events (working between `turn.start` and `turn.end`, plus `blocked`), and
  from the runtime only for a harness with no integration.
- Poll leases: on start, `recoverSending` moves `delivering` rows of polling sessions back to `pending` and the
  others to `failed`, each with an `inbox.status` reason `recovered`; the plugin acks by row id and skips rows it
  showed. A session may see one message twice after a vibestd restart.
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an open `process.start` with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open turn stays open, and the harness's turn end or reconciliation (idle, no result: lost) ends it.

## Moving from version 1

vibestd never migrates by itself: on a version 1 file it prints the command of a one-time migration script, which
the owner runs by hand. The script maps:

- `session.report_to_session_id` = `parent_session_id`; when that is null and the role is not `main`, the
  project's `main_session_id`.
- `project.entry_session_id` = `main_session_id`.
- v1 `report` rows become `send` rows (their sender is the session).

From version 3 on, upgrades run step by step on `user_version`.

## Not stored

- **Run**: none. Who spawned a session is `parent_session_id`; a skill that drives several sessions keeps their
  ids itself.
- **Capabilities**: the agent definition, in configuration.
- **Workspace**: `session.directory`.
- **Subscription**: vibestd memory, polled from CLIs and reported by plugins.
- **Machine**: configuration; online state is checked live; a session's machine is `session.machine`.

## Retention

None for now. Later: delete whole sessions that ended more than N days ago, with their events and inbox rows.
