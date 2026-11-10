# Schema

Status: vibestd runs version 1 (`user_version = 1`, in `packages/core/src/db-schema.ts`), the baseline: every later change
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
  `VIBEST_MAIN_ENV`, not on the command herdr types and not as names a shell rc can override. Only the command
  Launch typed reads it; a later `vibest` in that pane ignores it. That command passes the pairs on as its own `--env`. Inside herdr below the root, that same process continues at the root and types
  nothing (typing `cd && vibest --env …` would leave the values in the shell history). vibestd keeps them in its
  memory for a restart in place (`vibest update`); a handoff passes them to the next vibestd in that process's
  environment, which the next one reads once and removes, so nothing it starts inherits them. A vibestd that stops without a handoff forgets them.
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

vibest's own worktrees are repaired before the move is recorded: a stop in between leaves the project where it was, so
the next `vibest` asks again and repairs again (nothing left to do) before it records the move. Only worktrees under
vibest's worktrees root are repaired (their `.git` file pointed at the new place, as `git worktree repair` would);
git's own repair would rewrite every worktree of the repository, the user's included.

Agents read and write the project folder with their own file tools; vibestd only names its paths and searches its
text. Search reads every file per query; an index is the next step once a project folder grows past a few hundred
files. The system prompt indexes `memories/` by each file's frontmatter `description` (one `description:` line, not a
folded YAML block), else its first non-empty line.

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

### Optional objects

Tables and indexes added after the baseline without a numbered step are kept out of `SCHEMA` in `REMOTE_TABLES`
(`packages/core/src/db-remote.ts`), written `CREATE … IF NOT EXISTS`. Every open runs them in one write transaction
after `inspectSchema` accepted the file, a new one included. `inspectSchema` requires only
the baseline objects and ignores extra ones, so an older vibest still opens the file (a downgrade, or an old CLI's
`daemon import-check`) and never reads the new tables. `user_version` stays 1. A later change to the shape of one of
these tables is the first case that needs numbered upgrade steps. The optional objects are listed in
[multi-machine.md](multi-machine.md).

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

| type                 | link columns        | data                                                                                                                                                                                                                                    |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| process.start        | -                   | harness (an open string), provider?, model?, routing? (the plugins' decision record), runtime, machine, terminal, resume? (the conversation id it resumes), pid? (a main agent's launch)                                                |
| process.ready        | process_id          | pid, conversation?, integration {version, protocol}; may repeat after a plugin reload; pidOnly: a pid report that is not a ready report                                                                                                 |
| process.conversation | process_id          | conversation (a new conversation id: after /clear, or Pi at its first agent_end)                                                                                                                                                        |
| process.end          | process_id          | reason: exited, limited, restart, move, archived (also for vibest --new), launch_failed                                                                                                                                                 |
| turn.start           | process_id          | typed? (the text typed into the pane; none for a turn a delivery opened)                                                                                                                                                                |
| turn.reported        | process_id          | harness, text; error?, conversation?, interrupted? (only when present). The turn end as the hook reported it, before a check consumes it                                                                                                |
| turn.end             | process_id, turn_id | status: completed, failed, interrupted, lost, not_started; report? (the turn.reported it consumed), failure? {message}; output? only on rows written before report                                                                      |
| inbox.queued         | inbox_id            | request? (the request id of the `vibest send` or `vibest run` that queued the row, when its caller sent one; a repeat with it finds the row); the queue time is `at`                                                                    |
| inbox.status         | inbox_id, turn_id?  | to; on to = delivered, turn_id is the turn that consumed it                                                                                                                                                                             |
| peer.start           | -                   | peer (the identity id of the vibestd that started it), project (that vibestd's project id), parent? (its caller session), reportTo? (its session that gets the results; none when that project had no main agent); see multi-machine.md |

A turn's input is its typed text, or the inbox rows with an `inbox.status` event `to = delivered` and `turn_id` =
that turn. A delivery opens the turn before the rows move to delivered, so they get its id. A `task` is handed over
with the spawn, before any turn: its `inbox.status` is written by the turn it is handed into, at the handover (right
before its text goes), with that turn's id.

A `process.start` with terminal `""` is the choice made before its terminal opens (a spawn, a move to a new
terminal). The start with the terminal follows it and copies what the process reported meanwhile (its
`process.ready` and `process.conversation`); the one with no terminal is never ended. One whose terminal never
opened ends `launch_failed`, and the session's current process is then the start before it, if any.

A `turn.end` points at the `turn.reported` it consumed (`report`). That row's `text` is the harness's answer, not the
rendered result (the result row's content). Rows written before `report` keep the answer in `output`. `ls` reads
`coalesce(text, output)`. `Db.finishTurn` takes the whole `turn.end` data. An end the harness never reported
(`lost`, `not_started`, an exit, an interrupt) has no `report`.

A `turn.reported`'s `process_id` is the session's current process when vibestd received the hook, not the harness
that sent it: in a restart's window the new `process.start` is already written while the old harness still reports,
so that report carries the new process. What keeps it out is a fence on event ids: a report counts only when its id
is above the current process's first `process.ready` its integration wrote (a harness ends a turn only after it is
ready), or above the current `process.start` for a harness whose ready comes from the runtime (Cursor). The first,
not the latest: the same harness reports ready again (a plugin reload, a new conversation), and a report written
before that and not yet consumed still counts. A report a `turn.end` consumed is not taken again.

## The Db service

- All SQL is in `packages/core/src/db.ts` and its `db-*.ts` modules, over one SQLite connection; rows are decoded with Schema. The session row
  callers read (`SessionRow`) is a read model: its process, turn and live fields come from the `event` table, and
  every change to them appends an event.
- Opening: `inspectSchema` only reads, on a read-only connection, before the file is opened writable; it checks
  object names, not columns. An empty file gets the schema in one write transaction that checks again under the write
  lock, so of two empty opens at once one installs and the other sees it. `journal_mode = WAL` writes the header, so
  it is set only after the file is accepted: a refused file keeps its database and WAL bytes (its `-shm` may change).
  `synchronous = NORMAL` cannot corrupt a WAL database; a power loss may drop only the last commits, and it saves an
  fsync per commit.
- `tx` runs one transaction and publishes the events it appended after the commit, in id order. A nested `tx`
  shares the outer buffer, so only the outermost commit publishes; a rollback publishes nothing. Only the body is
  interruptible: once it has finished, the commit's rows are published before an interrupt lands. The buffer closes
  with its transaction, so a fiber forked inside one must not append.
- `createProject` inserts with `ON CONFLICT (directory) DO NOTHING`: two first requests can both miss the lookup.
- `insertSend` and `archiveIfNoPending` each run in one transaction: a Send accepted before an archive's tombstone
  wins, one after it is refused. A repeat of a request id returns the row it queued, checked before the archive (it
  was accepted).
- A main agent moving to another terminal has no place, but its rows wait for it. Rows for an absent main agent are
  dropped only while it still has no place, so a launch that landed in between keeps them.
- A usage-limit move resends the open turn's input (its typed text or the rows it consumed); when that is empty, the
  trailing run of delivered `task` and `send` rows from one sender that no turn consumed, oldest first, joined with a
  blank line.
- A task with no `inbox.status` was never handed over. A turn that ended before its handover (vibestd stopped while
  waiting for ready) took nothing, so the task is still handed over.
- An archived session is also marked `removed`, which older readers look for.

## Hot paths

- Pending rows: read when an event for their recipient arrives, and once in a reconcile (at start, when a runtime
  registers or comes back): inbox `WHERE status = 'pending' AND recipient_session_id IS NOT NULL` through
  `inbox_status`; the cost does not grow with history. Nothing scans on an interval.
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

- One-shot timers (engine): a session's turn-end grace and missed-turn check, a polling main agent's away timer, and
  one lease timer per row a poll handed out. Lost with the process; the start-up reconcile and `recoverDelivering`
  stand in for them.
- Live status: from the integration's events (working between `turn.start` and `turn.end`, plus `blocked`), and
  from the runtime only for a harness with no integration.
- Poll leases: on start, `recoverDelivering` (one transaction) moves `delivering` rows of polling main agents back
  to `pending` and the other main-agent rows to `failed`, each with an `inbox.status`; the plugin acks by row id and
  skips rows it showed. A session may see one message twice after a vibestd restart. A subagent's `delivering` rows
  fail with one notice ("may or may not have arrived") and are not delivered again.
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an open `process.start` with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open turn stays open, and the harness's turn end or reconciliation (idle, no result: lost) ends it.
- When an open turn's text was last handed over (after a resume or a move to the next harness): a turn end
  reported before it is not this turn's. Lost with the process; the turn's own start time stands then.
- A turn start an integration reports is published (`live.turn_start`), never stored: it marks the open turn as
  worked in the session's flags, which `forget` clears on its `process.end` or its archive. A turn end is a
  `turn.reported` event, written as the hook is admitted (a settlement, so it still lands while vibestd drains) and kept across a restart. The check that writes it as `turn.end` is a settlement too.
  After a restart the stored proof that a turn was taken up is its typed text or an inbox row delivered into it.
- The integration version a session's requests carry, until its next `process.ready` records it.
- A main agent moving to another terminal (`vibest` answered y): its rows keep waiting for it.

## Moving from the earlier shape

The shape before the baseline also carries vibest's `application_id` and `user_version` 1, so vibestd tells it apart by
its tables: no `event` table. vibest never migrates a database, and no migration script exists: on such a file, or any
file not of this schema, vibestd refuses to start, names the file, and gives the one way out, moving it aside with its
`-wal` and `-shm` files while vibestd is stopped, which loses the sessions, results and queued messages it holds.
`vibest update` and `vibest daemon restart` find this out before they change anything (the new binary runs
`vibest daemon import-check`, which opens the file read-only), so the old install and the old vibestd keep working and
the message says how to stop vibestd and move the file aside to go on.

From the baseline on, upgrades run step by step on `user_version`: 1 to 2, then 2 to 3, each a numbered SQL step.

## Not stored

- **This vibestd's identity**: `<home>/identity.json`, a state file beside `vibest.db`
  ([multi-machine.md](multi-machine.md)).

- **Run**: none. Who spawned a session is `parent_session_id`; a skill that drives several sessions keeps their
  ids itself.
- **Capabilities**: the agent definition, in configuration.
- **Workspace**: `session.directory`.
- **Subscription**: vibestd memory, polled from CLIs and reported by plugins.
- **Machine**: configuration; online state is checked live; a session's machine is `session.machine`.

## Retention

None for now. Later: delete whole sessions that ended more than N days ago, with their events and inbox rows.

## Event catalog v3 (not used yet)

`packages/schema/src/event.ts` defines the facts of the next storage shape: 25 types, each with its envelope (`project`,
`session` or `none`) and a Schema for its data. `packages/core/src/journal.ts` (the log, `commit`, `emit`, `rebuild`,
`equalToReplay`) and `packages/core/src/projectors.ts` (the read model and one projector per type) run them, so far only
from tests on `:memory:` databases; the live database is still the shape above. A key marked optional is absent, never
null, and a string key that is present is never empty. Encoding and decoding refuse keys a definition does not have, and
encoding fails when its JSON does not decode back (a number that is NaN or infinite becomes null in JSON). `Routing` and
`TraceEntry` (with `Change`) from `packages/schema/src/plugin.ts` are part of the catalog contract through
`process.started.routing`: change them by the same rules as a fact.

Changing the catalog: add an optional key directly; a change of meaning or structure gets a new type name and the old
definition stays in the catalog. Both raise `CATALOG_VERSION` by one. Changing the read model (a column, table, index or
projector rule) raises `PROJECTION_VERSION` instead; a database with another projection version is rebuilt by replaying
its log, so the read model needs no migration. `packages/schema/test/event-rows.json` holds fixed sample rows that must
keep decoding and re-encoding to the same bytes: add rows to it, never change or remove one.

### Importing a v1 database (not used yet)

`packages/core/src/import/` turns the v1 tables into catalog facts. `translate.ts` is pure: it reads a snapshot of every
v1 table and gives the facts in v1 event order, with `seq` starting above every v1 event id and inbox id, so an old
inbox id never names a new row. It fails, naming the v1 row, on an event type it does not know, a reference to a missing
process, turn or inbox row, an inbox row without its `inbox.queued` event, a turn end whose report is not an event id, and any
`machine` other than `local`; four known oddities and every second end of an already ended turn are counted instead and
printed by the report. `importInPlace` runs in one transaction on the database
file (no backup copy, foreign key checks deferred so it also works inside an outer transaction): read, translate, drop the v1 tables, install the ledger, append the facts, then the referee.
`importCheck` does the same from a read-only source into a `:memory:` database; `vibest daemon import-check --v2` prints
its report and exits non-zero when the referee finds a difference. Without `--v2` the command only checks that the
database opens, as before.

The referee (`referee.ts`) reads both databases through the same set of reads and compares them field by field: session
rows and columns, projects, coordinators, inbox rows (as the `Db` reads them, and the stored columns of every row including tasks), briefs, both latest-report fences, `hadTerminal`,
`untakenTask`, `rescheduleSource`, `queuedBy`, `spawnedBy`, machines, peers, each peer's outbox, and each `peer:` key.
`v1-read.ts` holds frozen copies of the v1 `Db` reads and must not change after the import ships; `ledger-read.ts` holds
the same reads over the read model, and the `Db` that moves onto the ledger reads through them so the referee keeps
judging what users see. A v1 subagent whose harness changed before it first opened and whose next placeholder then
failed to launch reads as still alive in v1 and ended in v2; the referee fails such a database rather than guess.

`packages/cli/test/fixtures/v1/*.sql` are v1 databases made by `generate.ts` through the v1 `Db` (run it with
`bun packages/cli/test/fixtures/v1/generate.ts` while the v1 `Db` still exists); `referee-fails.sql` is the case above.
`tools/bench/src/import-check.ts` seeds 100 000 v1 events and times `import-check --v2`; it must stay under 30 s.
