# Schema

Status: vibestd runs version 1 (`user_version = 1`, in `packages/core/src/db.ts`), the baseline: every later change
is a numbered SQL step, from 1 to 2 onward, run in order on `user_version`. The baseline replaced the earlier shape's
`message` table and `session.metadata` JSON column with the append-only `event` table, keys projects by a UUID and
their directory, and added the routing columns of the engine (architecture.md §1). The `Db` service still answers its callers with the old session row
shape, read from these tables and the memory listed below. Not built yet: rows for the user (nothing writes a null
`recipient_session_id`), the `replyTo(turn)` routing below (a result or report still goes to
`report_to_session_id` while it has not ended, else to the entry session).

Five SQLite tables, one purpose each:

- `project`: a Project, where it is, and its optional entry session.
- `project_repository`: the git repositories of a Project, by the realpath of each main checkout.
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
  terminal does not (a subagent resumed in a new terminal starts without them), and the user passes `--env` again. A
  main agent's `vibest --env` values go to the harness it execs. Outside herdr they travel as the pane's
  `VIBEST_MAIN_ENV`, not on the command herdr types and not as names a shell rc can override; the vibest in that pane
  passes them on as its own `--env`. Inside herdr below the root, that same process continues at the root and types
  nothing. vibestd keeps them in its memory for a restart in place (`vibest update`); a handoff passes them to the next
  vibestd in that process's environment. A vibestd that stops without a handoff forgets them.
- No peer relation and no worktree table. A session records its machine and directory. A directory under the vibest
  worktrees root is one vibest made; a name is reserved by an atomic `mkdir`. It can be removed when no other live
  session uses the same (machine, directory), then after the lsof and git checks.
- Branch and pushed state are rendered into the result text when the result inbox row is created; no table holds
  them.
- Results and reports reach the database through vibestd, never through files: there is no `results/` or `reports/`.
- Engine telemetry (lock waits, retries, hook timings) goes to logs and OpenTelemetry, not the event table.
- Leases, the restarting mark, running work and per-session locks are memory only (see Memory).
- Agent capabilities (spawn, message, tools) come from the agent definition in configuration, not from the
  database. A routing decision is not recorded separately: it is the recipient of the result row.
- Times are epoch milliseconds.
- Project and session ids are UUIDv4 strings from one generator (`newId`, packages/schema/src/id.ts), which draws
  again when the first 8 characters are already taken. People see the first 8 (`shortId`); every command that takes
  a session id takes the full id or a unique prefix of 8 or more characters, and JSON output keeps the full id. The
  herdr agent of a session is `s-` and the first 30 hex digits of its id (herdr names are at most 32 characters).

## Projects

A Project is found by realpath, never by a remote or a key. `projectRoot` of the working directory is a main checkout,
or the parent directory of a multi-repository project (a plain directory whose direct children are repositories). The
project is the one whose `directory` is that realpath, else the one with a repository at that path (a repository of
a multi-repository project belongs to it). Not found: a new project, with an id that never changes. Two clones of one
remote are two projects. `remote_url` is `remote.origin.url` as git prints it, refreshed on every resolve; it only
recognizes a moved checkout: a directory with no project, whose origins are exactly those of one project whose
directory no longer exists, is that project moved (`ProjectMoved`). `vibest` asks `[Y/n]`: yes moves the project there
(its id kept, its session directories rewritten, vibest's own worktrees repaired; for the user's worktrees it prints
`git worktree repair`), no makes a new project. Several such projects: a new project, the candidates printed. Its
folder is `projects/<project id>/` under `VIBEST_HOME` (preferences.md, docs/, memories/, artifacts/). `vibest ls` and the other
read-only lookups never create one.

## DDL

```sql
PRAGMA application_id = 1986617957;  -- 0x76696265, "vibe"
PRAGMA user_version = 1;

CREATE TABLE project (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),  -- UUIDv4, never changed
  directory        TEXT UNIQUE,                       -- realpath of the project root; null: migrated with none known
  entry_session_id TEXT REFERENCES session (id)       -- what a bare `vibest` reopens, and the fallback recipient; not identity
) STRICT;

CREATE TABLE project_repository (
  project_id TEXT NOT NULL REFERENCES project (id),
  path       TEXT NOT NULL UNIQUE,                    -- realpath of the repository's main checkout
  remote_url TEXT                                     -- remote.origin.url as git prints it; not identity
) STRICT;
CREATE INDEX project_repository_project ON project_repository (project_id);

CREATE TABLE session (
  id                    TEXT PRIMARY KEY,             -- UUIDv4
  project_id            TEXT NOT NULL REFERENCES project (id),
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
  kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
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
| `send`   | a message from the user or a session                                                                                    |
| `report` | a session's `vibest report` to its reply target: it expects no reply                                                    |
| `result` | a turn's result, rendered once from its `turn.end` (`result_event_id`), for the reply target                            |
| `notice` | something vibest tells the recipient about a session (`sender_session_id`): blocked, not started, undelivered, archived |

- Delivery scans rows with `recipient_session_id IS NOT NULL`. A row for the user is marked delivered once
  `vibest inbox` has shown it.
- The recipient of a result row is the routing decision of `replyTo(turn)` (architecture.md §1): (1) the sessions
  that sent the `task` and `send` rows the turn consumed; else (2) `report_to_session_id`; else (3) the user, when a
  row from the user opened the turn. (4) A turn woken by a `result` or `notice`, or opened by text typed in the pane,
  goes to `report_to_session_id` when it is set and makes no result row when it is not. An ended recipient falls
  back to the entry session (if live and not the session itself), then to the user; the `agent.result` hook may
  rewrite the recipients. A `notice` goes to `report_to_session_id`, then the entry session, then the user, and the
  `agent.notice` hook may rewrite them.

## Event types (data fields)

| type                 | link columns        | data                                                                                                                                                                                     |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| process.start        | -                   | harness (an open string), provider?, model?, routing? (the plugins' decision record), runtime, machine, terminal, resume? (the conversation id it resumes), pid? (a main agent's launch) |
| process.ready        | process_id          | pid, conversation?, integration {version, protocol}; may repeat after a plugin reload; pidOnly: a pid report that is not a ready report                                                  |
| process.conversation | process_id          | conversation (a new conversation id: after /clear, or Pi at its first agent_end)                                                                                                         |
| process.end          | process_id          | reason: exited, limited, restart, move, archived (also for vibest --new), launch_failed                                                                                                  |
| turn.start           | process_id          | typed? (the text typed into the pane; none for a turn a delivery opened)                                                                                                                 |
| turn.end             | process_id, turn_id | status: completed, failed, interrupted, lost, not_started; output?, failure? {message} (the harness error)                                                                               |
| inbox.queued         | inbox_id            | none (the queue time is `at`)                                                                                                                                                            |
| inbox.status         | inbox_id, turn_id?  | to; on to = delivered, turn_id is the turn that consumed it                                                                                                                              |

A turn's input is its typed text, or the inbox rows with an `inbox.status` event `to = delivered` and `turn_id` =
that turn. A delivery opens the turn before the rows move to delivered, so they get its id. A `task` is handed over
with the spawn, before any turn: its `inbox.status` is written by the first turn that starts, with that turn's id.

A `process.start` with terminal `""` is the choice made before its terminal opens (a spawn, a move to a new
terminal). The start with the terminal follows it and copies what the process reported meanwhile (its
`process.ready` and `process.conversation`); the one with no terminal is never ended. One whose terminal never
opened ends `launch_failed`, and the session's current process is then the start before it, if any.

`turn.end` `output` is the harness's answer text (not the rendered result, which is the result row's content); the
migration takes it out of an old-shape result. `Db.finishTurn` takes the whole `turn.end` data.

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
  (interrupted) and `process.end` (restart), then the new `process.start`. A refused SIGTERM writes
  nothing.
- `ls`: sessions by project, the first `task` row, the latest turn and live process as above, and the unread rows
  for the user. `result`: the latest `turn.end` with its result row.

## Memory

- Live status: from the integration's events (working between `turn.start` and `turn.end`, plus `blocked`), and
  from the runtime only for a harness with no integration.
- Poll leases: on start, `recoverSending` moves `delivering` rows of polling sessions back to `pending` and the
  others to `failed`, each with an `inbox.status`; the plugin acks by row id and skips rows it
  showed. A session may see one message twice after a vibestd restart.
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an open `process.start` with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open turn stays open, and the harness's turn end or reconciliation (idle, no result: lost) ends it.
- When an open turn's text was last handed over (after a resume or a move to the next harness): a turn end
  reported before it is not this turn's. Lost with the process; the turn's own start time stands then.
- The turn starts and turn ends the integrations reported (TurnEnds): an end until a check writes it as `turn.end`
  and its result row (that check is a settlement, so it still runs while vibestd drains), a start until the poll's
  sweep finds the session no longer live. Lost with the process: an end not yet written is lost, and reconciliation
  ends the turn lost.
  After a restart the stored proof that a turn was taken up is its typed text or an inbox row delivered into it.
- The integration version a session's requests carry, until its next `process.ready` records it.
- A main agent moving to another terminal (`vibest` answered y): its rows keep waiting for it.

## Moving from the earlier shape

The shape before the baseline also carries vibest's `application_id` and `user_version` 1, so vibestd tells it apart by
its tables: no `event` table. vibestd never migrates by itself: on such a file it refuses to start, names the file, and
says it is from an older vibest and must be migrated once with the migration script given with this release, or moved
aside to start empty. Nothing in the repository migrates anything. The script is not part of the repository: it is one
self-contained file (bun:sqlite and node built-ins only) handed out with the release, which the owner runs by hand
after stopping vibestd: `bun migrate-db-v2.ts ~/.vibest/vibest.db`. It recognizes the earlier shape by its tables, not
by `user_version`, copies the file to `vibest.db.v1-backup-<time>` first, builds the baseline from that copy into a new
file, checks its foreign keys, and only then puts it in place with `user_version` 1. The script maps:

- `session.report_to_session_id` = `parent_session_id`; when that is null and the role is not `main`, the
  project's `main_session_id`.
- Every project and session id becomes a new UUIDv4 (the script prints the old to new mapping), rewritten wherever
  it is held: `session.id`, `parent_session_id`, `report_to_session_id`, `project.entry_session_id`, the inbox sender
  and recipient, `event.session_id`, and a session id held as a value in event data. Harness conversation ids and
  message text are kept as they are. Stop every agent first: a running one still carries its old id.
- `project.entry_session_id` = `main_session_id`; a main session's `directory` = its `metadata.projectDirectory`.
  `project.directory` is the realpath of the main session's project directory (else the main checkout of a
  subagent's), with its repositories and their origins; projects claim directories newest first, and one with
  none known keeps a null directory (history only). `projects/<old key>/` is renamed `projects/<project id>/`, and
  inside it `memory/` becomes `memories/` and `scratch/` becomes `artifacts/`; any failure puts every renamed
  directory back and leaves the old file untouched.
- The session's harness, runtime, terminal and conversation become its `process.start`; its pid, ready time and
  integration a `process.ready`; its exit (or archive) a `process.end`; each usage-limit attempt a `process.start`
  and `process.end` (limited).
- Each `message` row becomes a `turn.start` (typed, when it had no inbox row and some input), the `inbox.status`
  delivered of the rows it consumed, and a `turn.end` unless it was still working.
- Inbox `sender_type` becomes the kind: `user` is the session's `task` (its `metadata.task`) or a `send`, `session`
  a `report`, or a `result` when it points at a message; `system` (and anything else) a `notice`. An old-shape result row's
  content is empty; its text is the message's output (the rendered result), which becomes the row's content.
- A turn end left in `results/<id>.json` that vibestd had not collected (newer than the open turn's start, or than
  the last turn's end for a turn typed in the pane) becomes that turn's `turn.end`; `results/` and `reports/` are
  then moved aside as `<dir>.v1-backup-<time>`.
- Dropped: stop records, the runtime's last status, a result's parsed details (derived again from its text), and
  every other `metadata` key.

From the baseline on, upgrades run step by step on `user_version`: 1 to 2, then 2 to 3, each a numbered SQL step.

## Not stored

- **Run**: none. Who spawned a session is `parent_session_id`; a skill that drives several sessions keeps their
  ids itself.
- **Capabilities**: the agent definition, in configuration.
- **Workspace**: `session.directory`.
- **Subscription**: vibestd memory, polled from CLIs and reported by plugins.
- **Machine**: configuration; online state is checked live; a session's machine is `session.machine`.

## Retention

None for now. Later: delete whole sessions that ended more than N days ago, with their events and inbox rows.
