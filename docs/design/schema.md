# Schema

Status: vibestd keeps an append-only log of facts (the `event` table) and a read model projected from it, in one SQLite
file, `vibest.db`. The facts are the catalog in `packages/schema/src/event.ts`; `packages/core/src/journal.ts` appends
them and `packages/core/src/projectors.ts` turns each into its read-model rows. The `Db` service
(`packages/core/src/db.ts` and its `db-*.ts` modules) answers its callers from the read model and changes nothing but by
appending facts. Not built yet: rows for the user (nothing writes a null `recipient_session_id`), the `replyTo(turn)`
routing below (a result or report still goes to `report_to_session_id` while it has not ended, else to the entry
session).

- `event`: the log. Each row is one fact: `seq` (its order and id), `at`, `type`, the project or session it is about
  (its envelope), and `data`, the fact's fields as JSON, written once.
- `meta`: `catalog` (the newest catalog version that wrote to this file) and `projection` (the read model's version).
- `migration`: the ids of the migrations applied to this file.
- The read model, one purpose per table: `project`, `project_repository`, `session`, `process` (one harness run of a
  session), `turn`, `inbox` (text for a session or for the user, and whether it was delivered), `machine` and `peer`
  (other vibestds), `outbox` (results and notices waiting for another vibestd).

## Rules

- Record only facts vibest alone knows and cannot read back later: decisions, events it saw, inputs, times. Read
  git, files, the runtime and the configuration when they are needed.
- Every change is a fact appended to the `event` log; the log is never updated. Only the projectors and the import
  write the read model (`tools/check/projector-writes.test.ts`), and no query reads into a fact's payload
  (`tools/check/no-payload-sql.test.ts`).
- `--env` values are never stored: not in the database, logs or telemetry. They reach the terminal only when it
  opens. An in-place restart or a harness change in the same pane keeps them (the pane's shell has them); a new
  terminal does not (a subagent resumed in a new terminal starts without them), and the user passes `--env` again. A
  main agent's `vibest --env` values go to the harness it execs. Outside herdr they travel as the pane's
  `VIBEST_MAIN_ENV`, not on the command herdr types and not as names a shell rc can override. Only the command
  Launch typed reads it; a later `vibest` in that pane ignores it. That command passes the pairs on as its own `--env`. Inside herdr below the root, that same process continues at the root and types
  nothing (typing `cd && vibest --env …` would leave the values in the shell history). vibestd keeps them in its
  memory for a restart in place (`vibest update`); a handoff passes them to the next vibestd in that process's
  environment, which the next one reads once and removes, so nothing it starts inherits them. A vibestd that stops without a handoff forgets them.
- Everything in one database is local: a session, a process and a terminal are on this machine, and no fact names a
  machine. A session on another machine lives in that machine's vibestd (multi-machine.md). No worktree table: a
  session records its directory. A directory under the vibest worktrees root is one vibest made; a name is reserved by
  an atomic `mkdir`. It can be removed when no other live session uses the same directory, then after the lsof and git
  checks.
- Branch and pushed state are rendered into the result text when the result inbox row is created; no table holds
  them.
- Results and reports reach the database through vibestd, never through files: there is no `results/` or `reports/`.
- Engine telemetry (lock waits, retries, hook timings) goes to logs and OpenTelemetry, not the event log.
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

CREATE TABLE event (                                  -- the log; append-only
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,       -- never reused, so a seq names one fact for good
  at         INTEGER NOT NULL,
  type       TEXT    NOT NULL,                        -- a catalog type
  project_id TEXT,                                    -- envelope "project"
  session_id TEXT,                                    -- envelope "session"
  data       TEXT    NOT NULL                         -- the fact's fields, by its definition
) STRICT;
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
  BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT;

CREATE TABLE project (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),  -- UUIDv4, never changed
  directory        TEXT UNIQUE,                       -- realpath of the project root; null: imported with none known
  entry_session_id TEXT,                              -- what a bare `vibest` reopens, and the fallback recipient; not identity
  seq              INTEGER NOT NULL
) STRICT;

CREATE TABLE project_repository (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,                    -- realpath of the repository's main checkout
  remote_url TEXT                                     -- remote.origin.url as git prints it; not identity
) STRICT;
CREATE INDEX project_repository_project ON project_repository (project_id);

CREATE TABLE session (
  id                    TEXT PRIMARY KEY,             -- UUIDv4
  project_id            TEXT NOT NULL,
  parent_session_id     TEXT,                         -- who spawned it; null: the user. Rights and placement, never routing
  report_to_session_id  TEXT,                         -- where its results go; written at spawn, never changed; null: the user
  role                  TEXT NOT NULL,                -- agent definition name (open set)
  name                  TEXT NOT NULL,
  directory             TEXT NOT NULL,
  archive_on_completion INTEGER NOT NULL DEFAULT 0 CHECK (archive_on_completion IN (0, 1)),
  origin_peer           TEXT,                         -- started by another vibestd: its id
  origin_project        TEXT,                         -- and its project, caller and result session there
  origin_parent         TEXT,
  origin_report_to      TEXT,
  created_at            INTEGER NOT NULL,
  ended_at              INTEGER,                      -- archived, or replaced by vibest --new
  process_id            INTEGER,                      -- its current process
  turn_id               INTEGER,                      -- its latest turn
  active_at             INTEGER,
  seq                   INTEGER NOT NULL
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent  ON session (parent_session_id);
CREATE INDEX session_live    ON session (directory) WHERE ended_at IS NULL;
CREATE INDEX session_origin  ON session (origin_peer, origin_project) WHERE origin_peer IS NOT NULL;

CREATE TABLE process (                                -- id: the seq of its process.started
  id                   INTEGER PRIMARY KEY,
  session_id           TEXT NOT NULL,
  harness              TEXT NOT NULL,
  provider             TEXT,
  model                TEXT,
  routing              TEXT,                          -- the plugins' decision record
  resume               TEXT,                          -- the conversation id it resumes
  runtime              TEXT NOT NULL,
  terminal             TEXT,                          -- null until it is placed
  pid                  INTEGER,
  integration_version  TEXT,
  integration_protocol INTEGER,
  conversation         TEXT,
  started_at           INTEGER NOT NULL,
  placed_at            INTEGER,
  ready_at             INTEGER,
  ready_seq            INTEGER,                       -- its first process.ready
  ended_at             INTEGER,
  end_reason           TEXT
) STRICT;
CREATE UNIQUE INDEX process_live ON process (session_id) WHERE ended_at IS NULL;
CREATE INDEX process_session  ON process (session_id, id);
CREATE INDEX process_terminal ON process (runtime, terminal) WHERE ended_at IS NULL AND terminal IS NOT NULL;

CREATE TABLE turn (                                   -- id: the seq of its turn.started
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  process_id INTEGER,
  typed      TEXT,                                    -- the text typed into the pane; none for a turn a delivery opened
  started_at INTEGER NOT NULL,
  status     TEXT CHECK (status IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),  -- null: open
  report_seq INTEGER,                                 -- the turn.reported it consumed
  failure    TEXT,
  ended_at   INTEGER
) STRICT;
CREATE UNIQUE INDEX turn_open ON turn (session_id) WHERE status IS NULL;
CREATE INDEX turn_session ON turn (session_id, id);
CREATE INDEX turn_report  ON turn (report_seq) WHERE report_seq IS NOT NULL;

CREATE TABLE inbox (                                  -- id: the seq of its inbox.queued
  id                   INTEGER PRIMARY KEY,
  recipient_session_id TEXT,                          -- null: the user
  sender_session_id    TEXT,                          -- null: the user; notice: the session it is about
  kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
  content              TEXT NOT NULL,                 -- result: the rendered result text with branch and pushed
  result_turn_id       INTEGER,                       -- result: the turn it reports
  request              TEXT,                          -- the request id of the `vibest send` or `vibest run` that queued it
  peer_item            TEXT,                          -- a notice from another vibestd: its outbox item id
  status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
  turn_id              INTEGER,                       -- delivered: the turn that took it
  queued_at            INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  CHECK ((kind = 'result') = (result_turn_id IS NOT NULL)),
  CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)
) STRICT;
CREATE INDEX inbox_status    ON inbox (status, recipient_session_id);   -- full index on purpose: a partial IN (...) index is not used for status = 'pending'
CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id);
CREATE INDEX inbox_result    ON inbox (result_turn_id) WHERE result_turn_id IS NOT NULL;
CREATE INDEX inbox_turn      ON inbox (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX inbox_request   ON inbox (request) WHERE request IS NOT NULL;
CREATE UNIQUE INDEX inbox_peer_item ON inbox (peer_item) WHERE peer_item IS NOT NULL;
```

`machine`, `peer` and `outbox` are in [multi-machine.md](multi-machine.md). There are no foreign keys and no other
triggers: the projectors keep the read model whole, and one live process and one open turn per session are unique
indexes, so a fact that would break them fails its transaction.

## Inbox

An inbox row is text for one recipient: a session, or the user (`recipient_session_id` null).

| `kind`   | What it is                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `task`   | the first input of a session, from whoever spawned it                                                                   |
| `send`   | a message from the user or a session                                                                                    |
| `report` | a session's `vibest report` to its reply target: it expects no reply                                                    |
| `result` | a turn's result, rendered once from its `turn.ended` (`result_turn_id`), for the reply target                           |
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

## Facts

`packages/schema/src/event.ts` defines 25 types, each with its envelope (`project`, `session` or `none`) and a Schema for
its data. A key marked optional is absent, never null, and a string key that is present is never empty. Encoding and
decoding refuse keys a definition does not have, and encoding fails when its JSON does not decode back. `Routing` and
`TraceEntry` (with `Change`) from `packages/schema/src/plugin.ts` are part of the catalog contract through
`process.started.routing`: change them by the same rules as a fact.

| type                                | data                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| project.created                     | directory?, repositories                                                                                    |
| project.moved                       | from, to, repositories                                                                                      |
| project.repositories_changed        | repositories                                                                                                |
| project.entry_changed               | session? (none: the project has no entry session)                                                           |
| session.created                     | role, name, directory, parent?, reportTo?, archiveOnCompletion, origin? {peer, project, parent?, reportTo?} |
| session.renamed                     | name                                                                                                        |
| session.directory_changed           | directory                                                                                                   |
| session.ended                       | reason: archived, replaced (vibest --new)                                                                   |
| process.started                     | harness, provider?, model?, routing?, resume?, runtime, terminal?, pid? (a main agent's launch)             |
| process.placed                      | process, terminal, pid?: the terminal of a process started before its terminal opened                       |
| process.ready                       | process, pid?, integration? {version, protocol}; may repeat after a plugin reload                           |
| process.pid                         | process, pid: a pid report that is not a ready report                                                       |
| process.conversation                | process, conversation (a new conversation id: after /clear, or Pi at its first agent_end)                   |
| process.ended                       | process, reason: exited, limited, restart, move, archived, launch_failed, superseded                        |
| turn.started                        | process?, typed? (the text typed into the pane)                                                             |
| turn.reported                       | process?, harness, text, error?, conversation?, interrupted?: the turn end as the hook reported it          |
| turn.ended                          | turn, status, report? (the turn.reported it consumed), failure? {message}                                   |
| inbox.queued                        | kind, recipient?, sender?, content, status: pending, delivered or dropped, turn?, request?, peerItem?       |
| inbox.moved                         | inbox, to, turn? (on to = delivered: the turn that took it)                                                 |
| machine.added, .connected, .removed | name (added: target, vibestd)                                                                               |
| peer.seen                           | id, name, callsMe                                                                                           |
| outbox.queued                       | id, peer, kind: result or notice, content                                                                   |
| outbox.acked                        | peer, ids                                                                                                   |

A turn's input is its typed text, or the inbox rows that moved to delivered with that turn. A delivery opens the turn
before the rows move to delivered, so they get its id. A `task` is handed over with the spawn, before any turn: its
`inbox.moved` is written by the turn it is handed into, at the handover (right before its text goes), with that turn's
id.

A process started before its terminal opens (a spawn, a move to a new terminal) gets `process.placed` once the terminal
is there; it stays one process. Any other start while the session still has a live process first ends that one
`superseded`. One whose terminal never opened ends `launch_failed`, and the session's current process is then the one
before it, if any. Superseded processes are not exits: no reader counts them as one.

A `turn.ended` points at the `turn.reported` it consumed (`report`). That row's `text` is the harness's answer, not the
rendered result (the result row's content). An end the harness never reported (`lost`, `not_started`, an exit, an
interrupt) has no `report`.

A `turn.reported`'s `process` is the session's current process when vibestd received the hook, not the harness that
sent it: in a restart's window the new process is already started while the old harness still reports, so that report
carries the new process. What keeps it out is a fence on `seq`: a report counts only when its seq is above the current
process's first `process.ready` its integration wrote (`ready_seq`; a harness ends a turn only after it is ready), or
above the process's own start for a harness whose ready comes from the runtime (Cursor). The first, not the latest: the
same harness reports ready again (a plugin reload, a new conversation), and a report written before that and not yet
consumed still counts. A report a `turn.ended` consumed is not taken again.

Changing the catalog: add an optional key directly; a change of meaning or structure gets a new type name and the old
definition stays in the catalog. Both raise `CATALOG_VERSION` by one. Changing the read model (a column, table, index or
projector rule) raises `PROJECTION_VERSION` instead; a database with another projection version is rebuilt by replaying
its log when it opens, so the read model needs no migration. `packages/schema/test/event-rows.json` holds fixed sample
rows that must keep decoding and re-encoding to the same bytes: add rows to it, never change or remove one.

## The Db service

- All SQL is in `packages/core/src/db.ts` and its `db-*.ts` modules, over one SQLite connection. The session row
  callers read (`SessionRow`) is built from the read model plus the memory listed below (`ledger-read.ts` holds the
  reads the import's referee shares).
- `commit` runs one transaction and publishes the facts it appended after the commit, in seq order. A nested `commit`
  shares the outer buffer, so only the outermost commit publishes; a rollback publishes nothing. Only the body is
  interruptible: once it has finished, the commit's facts are published before an interrupt lands. The buffer closes
  with its transaction, so a fiber forked inside one must not append.
- `createProject` looks the directory up inside its transaction and creates the project only when none has it: two
  first requests can both miss a lookup made outside it.
- `insertSend` and `archiveIfNoPending` each run in one transaction: a Send accepted before an archive wins, one after
  it is refused. A repeat of a request id returns the row it queued, checked before the archive (it was accepted).
- A main agent moving to another terminal has no place, but its rows wait for it. Rows for an absent main agent are
  dropped only while it still has no place, so a launch that landed in between keeps them.
- A usage-limit move resends the open turn's input (its typed text or the rows it consumed); when that is empty, the
  trailing run of delivered `task` and `send` rows from one sender that no turn consumed, oldest first, joined with a
  blank line.
- A task still pending was never handed over. A turn that ended before its handover (vibestd stopped while waiting for
  ready) took nothing, so the task is still handed over.
- A conversation can be resumed when a process of the session that resumed it or reported it has an ended turn, or,
  for an entry session, when a process of it reported it. The read model keeps only each process's latest
  conversation, so an earlier one in the same process no longer counts.

## Opening and migrations

`packages/core/src/database/migration.ts` opens the file, as OpenCode does:

1. `inspectSchema` reads the file on a read-only connection before it is opened writable. A wrong `application_id`, a
   file of the shape from before the event table, or one missing objects it needs is refused (`SchemaMismatch`) without
   changing its bytes; the message gives the way out, moving it aside with its `-wal` and `-shm` files while vibestd is
   stopped. A file whose `meta.catalog` is newer than this vibest's catalog is refused with "was written by a newer
   vibest …: run vibest update"; this vibest never skips a fact type it does not know.
2. An empty file gets the current schema in one write transaction that checks again under the write lock (so of two
   empty opens at once one installs and the other sees it), with every migration marked applied.
3. Each migration in `migrations` that the `migration` table does not list runs in its own transaction, in order, and
   its id is recorded. A migration is a module `packages/core/src/database/migration/<timestamp>_<name>.ts` with an `id`
   and an `up(tx)`. Migrations stay in the code for good; there are no one-off scripts outside the repository.
   `user_version` is not read.
4. In one transaction: when `meta.projection` differs from `PROJECTION_VERSION`, the read model is dropped and rebuilt
   by replaying the log; then `meta.catalog` is set to this vibest's catalog version.
5. `journal_mode = WAL` writes the header, so it is set only after the file is accepted: a refused file keeps its
   database and WAL bytes (its `-shm` may change). `synchronous = NORMAL` cannot corrupt a WAL database; a power loss
   may drop only the last commits, and it saves an fsync per commit.

`vibest update` and `vibest daemon restart` run the new binary's `vibest daemon import-check` (read-only, no lock) before
they change anything. On a ledger it replays the log into a `:memory:` database and, when the projection versions
match, compares every read-model table with the replay; a difference or a fact that does not decode fails it, naming
the first differing row or the fact's `seq`. On a database from before the ledger it only checks that the file opens.
E2E runs it on every world's database at the end of each check.

### The first migration: importing a v1 database

`20261110120000_ledger` turns a database of the earlier shape (`user_version` 1, the v1 `event` and `inbox` tables) into
the ledger in place. `packages/core/src/import/translate.ts` is pure: it reads a snapshot of every v1 table and gives the
facts in v1 event order (an inbox row's `inbox.queued` is translated before the row's first other event, since an older
migration backfilled some queued events with later ids), with `seq` starting above every v1 event id and inbox id, so an
old inbox id never names a new row. It fails, naming the v1 row, on an event type it does not know, a reference to a
missing process, turn or inbox row, an inbox row without its `inbox.queued` event, a turn end whose report is not an
event id, and any `machine` other than `local`; four known oddities and every second end of an already ended turn are
counted instead. All problems are collected and reported together. `importInPlace` runs inside the migration's
transaction on the database file (no backup copy; `PRAGMA defer_foreign_keys` stays on until the outer transaction
ends): read, translate, drop the v1 tables, install the ledger, append the facts, then the referee.

When any of that fails, vibestd still starts: the import rolls back, then in the same migration transaction the v1
tables are renamed `v1_<name>` (their indexes and triggers dropped), an empty ledger is installed, and the migration is
recorded, so it is not tried again. The reason goes to stderr, which is the vibestd log (`LedgerNotImported: …`); the
`vibest` that started vibestd prints that line, and `vibest ls` carries a `notice` that the old history was not
imported. The `v1_` tables only let a later version try again.

The referee (`referee.ts`) reads both databases through the same set of reads and compares them field by field: session
rows and columns, projects, coordinators, inbox rows (as the `Db` reads them, and the stored columns of every row
including tasks), briefs, both latest-report fences, `hadTerminal`, `untakenTask`, `rescheduleSource`, `queuedBy`,
`spawnedBy`, machines, peers, each peer's outbox, and each `peer:` key. `v1-read.ts` holds frozen copies of the v1 `Db`
reads and must not change; `ledger-read.ts` holds the same reads over the read model, which the `Db` reads through, so
the referee judges what users see. A v1 subagent whose harness changed before it first opened and whose next
placeholder then failed to launch reads as still alive in v1 and ended in v2; the referee fails such a database rather
than guess. `vibest daemon import-check --v2` runs the same import from a read-only source into `:memory:` and prints its
report (events, facts, time, the counts, the referee's result).

`packages/core/test/fixtures/v1/*.sql` are v1 databases made through the v1 `Db` before it was removed (the generator
went with it); `referee-fails.sql` is the case above. `tools/bench/src/import-check.ts` seeds 100 000 v1 events and
times `import-check --v2`; it must stay under 30 s.

## Hot paths

- Pending rows: read when a fact for their recipient arrives, and once in a reconcile (at start, when a runtime
  registers or comes back): inbox `WHERE status = 'pending' AND recipient_session_id IS NOT NULL` through
  `inbox_status`; the cost does not grow with history. Nothing scans on an interval.
- Open turn of a session: `turn_open`. Live process and pid: `session.process_id`, or `process_live`.
- Session or entry session by terminal: `process_terminal`, joined to `session.process_id` and
  `project.entry_session_id`.
- Usage-limit attempts: the session's processes that ended `limited`, with their harness and provider.
- In-place restart after an update: live sessions (`session_live`), their live process, compare the integration.
  Order: restarting mark in memory, SIGTERM, then `turn.ended` (interrupted) and `process.ended` (restart), then the new
  `process.started`. A refused SIGTERM writes nothing.
- `ls`: sessions by project, the first `task` row, the latest turn and live process as above, and the unread rows for
  the user. `result`: the latest ended turn with its result row.

## Memory

- One-shot timers (engine): a session's turn-end grace and missed-turn check, a polling main agent's away timer, and
  one lease timer per row a poll handed out. Lost with the process; the start-up reconcile and `recoverDelivering`
  stand in for them.
- Live status: from the integration's events (working between `turn.started` and `turn.ended`, plus `blocked`), and
  from the runtime only for a harness with no integration.
- Poll leases: on start, `recoverDelivering` (one transaction) moves `delivering` rows of polling main agents back
  to `pending` and the other main-agent rows to `failed`, each with an `inbox.moved`; the plugin acks by row id and
  skips rows it showed. A session may see one message twice after a vibestd restart. A subagent's `delivering` rows
  fail with one notice ("may or may not have arrived") and are not delivered again.
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an unended process with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open turn stays open, and the harness's turn end or reconciliation (idle, no result: lost) ends it.
- When an open turn's text was last handed over (after a resume or a move to the next harness): a turn end
  reported before it is not this turn's. Lost with the process; the turn's own start time stands then.
- A turn start an integration reports is published (`live.turn_start`), never stored: it marks the open turn as
  worked in the session's flags, which `forget` clears on its `process.ended` or its archive. A turn end is a
  `turn.reported` fact, written as the hook is admitted (a settlement, so it still lands while vibestd drains) and kept across a restart. The check that writes it as `turn.ended` is a settlement too.
  After a restart the stored proof that a turn was taken up is its typed text or an inbox row delivered into it.
- The integration version a session's requests carry, until its next `process.ready` records it.
- A main agent moving to another terminal (`vibest` answered y): its rows keep waiting for it.

## Not stored

- **This vibestd's identity**: `<home>/identity.json`, a state file beside `vibest.db`
  ([multi-machine.md](multi-machine.md)).
- **Run**: none. Who spawned a session is `parent_session_id`; a skill that drives several sessions keeps their
  ids itself.
- **Capabilities**: the agent definition, in configuration.
- **Workspace**: `session.directory`.
- **Subscription**: vibestd memory, polled from CLIs and reported by plugins.
- **Machine of a session**: every session in the file is on this machine.

## Retention

None for now. Later: delete whole sessions that ended more than N days ago, with their facts and inbox rows (a
compaction of the log).
