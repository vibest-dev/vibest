# Schema

Status: vibestd keeps an append-only log of facts (the `event` table) and a read model projected from it, in one SQLite
file, `vibest.db`. The facts are the catalog in `packages/schema/src/event.ts`; `packages/core/src/bus.ts` appends
them and the projectors of `packages/core/src/project/projector.ts`, `session/projector.ts` and `remote/projector.ts`, each registered with `bus.project`, turn each into its read-model rows; a replay reaching a fact type with no registered projector fails. The `Db` service
(`packages/core/src/database/db.ts` and its domain modules) answers its callers from the read model and changes nothing but by
appending facts.

- `event`: the log. Each row is one fact of one aggregate: `aggregate` (the id of what it is about), `seq` (its number
  within that aggregate: each new fact takes the aggregate's highest `seq` plus one; facts rewritten from the old shape
  keep their old number, so an older aggregate's numbers have gaps), `at`, `type`, and `data`, the fact's fields as JSON, written once.
  `position` is the file's local order of all rows; only the bus reads it (to replay, to copy the log, and as the order `Events` reads the whole log in), and no
  fact or read-model row stores it (oxlint rule `vibest/event-reads`).
- Aggregates: a `session` (its id; every `session.*`, `process.*`, `execution.*` and `inbox.*` fact), a `project`
  (its id; `project.*`), and the `ledger` (`meta.ledger`, a UUID made when the file is created; `machine.*`, `peer.*`,
  `outbox.*`). Which aggregate a type belongs to is part of its catalog definition.
- `meta`: `catalog` (the newest catalog version that wrote to this file), `projection` (the read model's version) and
  `ledger` (this file's ledger aggregate id).
- `migration`: the ids of the migrations applied to this file.
- The read model, one purpose per table: `project`, `project_repository`, `session`, `process` (one harness run of a
  session), `execution` (one input a session handled until it ended), `inbox` (text for a session, and whether it was
  delivered), `machine` and `peer` (other vibestds), `outbox` (notices waiting for another vibestd).

## Rules

- Record only facts vibest alone knows and cannot read back later: decisions, events it saw, inputs, times. Read
  git, files, the runtime and the configuration when they are needed.
- Every change is a fact appended to the `event` log; the log is never updated. Only the projectors and the import
  write the read model (oxlint rule `vibest/projector-writes`), and no query reads into a fact's payload
  (oxlint rule `vibest/no-payload-sql`).
- `--env` values are never stored: not in the database, logs or telemetry. They reach the terminal only when it
  opens. An in-place restart or a harness change in the same pane keeps them (the pane's shell has them); a new
  terminal does not (a subagent resumed in a new terminal starts without them), and the user passes `--env` again. A
  entry session's `vibest --env` values go to the harness it execs. Outside herdr they travel as the pane's
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
- Replies and messages reach the database through vibestd, never through files: there is no `results/` or `reports/`.
- Engine telemetry (lock waits, retries, hook timings) goes to logs and OpenTelemetry, not the event log.
- Leases, the restarting mark, running work and per-session locks are memory only (see Memory).
- Agent capabilities (spawn, message, tools) come from the agent definition in configuration, not from the
  database. A routing decision is not recorded separately: it is the recipient of the notice or send row.
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
  position  INTEGER PRIMARY KEY AUTOINCREMENT,        -- this file's order; never reused, read only by the bus
  aggregate TEXT    NOT NULL,                         -- a session, project or ledger id
  seq       INTEGER NOT NULL,                         -- 1, 2, … within the aggregate; (aggregate, seq) names one fact
  at        INTEGER NOT NULL,
  type      TEXT    NOT NULL,                         -- a catalog type
  data      TEXT    NOT NULL,                         -- the fact's fields, by its definition
  UNIQUE (aggregate, seq)
) STRICT;
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
  BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT;

CREATE TABLE project (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),  -- UUIDv4, never changed
  directory        TEXT UNIQUE,                       -- realpath of the project root; null: imported with none known
  entry_session_id TEXT                               -- what a bare `vibest` reopens, and the fallback recipient; not identity
) STRICT;

CREATE TABLE project_repository (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,                    -- realpath of the repository's main checkout
  remote_url TEXT                                     -- remote.origin.url as git prints it; not identity
) STRICT;
CREATE INDEX project_repository_project ON project_repository (project_id);

CREATE TABLE session (
  id                    TEXT PRIMARY KEY,             -- UUIDv4; also its aggregate id
  project_id            TEXT NOT NULL,
  parent_session_id     TEXT,                         -- the session that created it; null: the user. Its notices go here while it lives
  agent                 TEXT NOT NULL,                -- agent definition name (open set)
  name                  TEXT NOT NULL,
  directory             TEXT NOT NULL,
  origin_peer           TEXT,                         -- started by another vibestd: its id
  origin_project        TEXT,                         -- and its project there
  origin_session        TEXT,                         -- and the session there its notices and sends go to (that project's entry session)
  created_at            INTEGER NOT NULL,
  ended_at              INTEGER,                      -- archived, or replaced by vibest --new
  process_id            INTEGER,                      -- its current process; its latest execution is its highest execution id
  active_at             INTEGER
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent  ON session (parent_session_id);
CREATE INDEX session_live    ON session (directory) WHERE ended_at IS NULL;
CREATE INDEX session_origin  ON session (origin_peer, origin_project) WHERE origin_peer IS NOT NULL;

CREATE TABLE process (                                -- id: the seq of its process.started in the session
  session_id           TEXT    NOT NULL,
  id                   INTEGER NOT NULL,
  harness              TEXT    NOT NULL,
  provider             TEXT,
  model                TEXT,
  routing              TEXT,                          -- the plugins' decision record
  runtime              TEXT    NOT NULL,
  terminal             TEXT,                          -- null until it is placed
  pid                  INTEGER,
  integration_version  TEXT,
  integration_protocol INTEGER,
  conversation         TEXT,                          -- the conversation id: the one it resumes, then the one it reports
  started_at           INTEGER NOT NULL,
  placed_at            INTEGER,
  ready_at             INTEGER,
  ended_at             INTEGER,
  end_reason           TEXT,
  PRIMARY KEY (session_id, id)
) STRICT;
CREATE UNIQUE INDEX process_live ON process (session_id) WHERE ended_at IS NULL;
CREATE INDEX process_terminal ON process (runtime, terminal) WHERE ended_at IS NULL AND terminal IS NOT NULL;

CREATE TABLE execution (                              -- id: the seq of its execution.started in the session
  session_id TEXT    NOT NULL,
  id         INTEGER NOT NULL,
  process_id INTEGER,
  typed      TEXT,                                    -- the text typed into the pane; none for one a delivery opened
  started_at INTEGER NOT NULL,
  accepted_at INTEGER,                                -- its execution.accepted: the harness took the input up
  outcome    TEXT CHECK (outcome IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),  -- null: open
  failure    TEXT,
  failure_kind TEXT CHECK (failure_kind IN ('limit')),  -- limit: the harness hit its usage limit
  reply      TEXT,                                    -- the reply its execution.ended carried; null: none (lost, an exit)
  ended_at   INTEGER,
  PRIMARY KEY (session_id, id)
) STRICT;
CREATE UNIQUE INDEX execution_open ON execution (session_id) WHERE outcome IS NULL;

CREATE TABLE inbox (                                  -- id: the seq of its inbox.queued in the recipient session
  session_id        TEXT    NOT NULL,                 -- the recipient
  id                INTEGER NOT NULL,
  sender_session_id TEXT,                             -- null: the user; notice: the session it is about
  kind              TEXT    NOT NULL CHECK (kind IN ('task', 'send', 'notice')),
  content           TEXT    NOT NULL,
  request           TEXT,                             -- the request id of the `vibest send` or `vibest run` that queued it
  peer_item         TEXT,                             -- a notice from another vibestd: its outbox item id
  status            TEXT    NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
  execution_id      INTEGER,                          -- delivered: the execution that took it
  PRIMARY KEY (session_id, id)
) STRICT;
CREATE INDEX inbox_status    ON inbox (status, session_id);   -- full index on purpose: a partial IN (...) index is not used for status = 'pending'
CREATE INDEX inbox_kind      ON inbox (session_id, kind, id);
CREATE INDEX inbox_execution ON inbox (session_id, execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX inbox_request   ON inbox (request) WHERE request IS NOT NULL;
CREATE UNIQUE INDEX inbox_peer_item ON inbox (peer_item) WHERE peer_item IS NOT NULL;
```

`machine`, `peer` and `outbox` are in [multi-machine.md](multi-machine.md). There are no foreign keys and no other
triggers: the projectors keep the read model whole, and one live process and one open execution per session are
unique indexes, so a fact that would break them fails its transaction.

## Inbox

An inbox row is text for one recipient session (`session_id`); its id is the `seq` of its `inbox.queued` in that
session, so a row is named by both.

| `kind`   | What it is                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`   | the first input of a session, from whoever spawned it                                                                                              |
| `send`   | a message from the user to any unfinished session of the project, or from a session to its creator or a session it started                         |
| `notice` | something vibest tells the recipient about a session (`sender_session_id`): blocked, not started, undelivered, archived, exited, ended in an error |

- An execution end writes no inbox row. The recipient of a `notice` is `parent_session_id` while it lives, then the entry
  session, then `origin_session` through the outbox; an undeliverable `send` notifies its sender.

## Facts

`packages/schema/src/event.ts` defines 24 types, each with its aggregate kind (`session`, `project` or `ledger`) and a
Schema for its data. `Bus.publish` takes the aggregate from the kind: a session fact needs a session id and no project
id, a project fact a project id and no session id, a ledger fact neither. A key marked optional is absent, never null, and a string key that is present is never empty. Encoding and
decoding refuse keys a definition does not have, and encoding fails when its JSON does not decode back. `Routing` and
`TraceEntry` (with `Change`) from `packages/schema/src/plugin.ts` are part of the catalog contract through
`process.started.routing`: change them by the same rules as a fact.

| type                                | data                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| project.created                     | directory?, repositories                                                                                               |
| project.moved                       | from, to, repositories                                                                                                 |
| project.repositories_changed        | repositories                                                                                                           |
| project.entry_changed               | session? (none: the project has no entry session)                                                                      |
| session.created                     | project, agent, name, directory, parent?, origin? {peer, project, session?}                                            |
| session.renamed                     | name                                                                                                                   |
| session.directory_changed           | directory                                                                                                              |
| session.ended                       | reason: archived, replaced (vibest --new)                                                                              |
| process.started                     | harness, provider?, model?, routing?, resume?, runtime, terminal?, pid? (an entry session's launch)                    |
| process.placed                      | process, terminal, pid?: the terminal of a process started before its terminal opened                                  |
| process.ready                       | process, pid?, integration? {version, protocol}; may repeat after a plugin reload                                      |
| process.pid                         | process, pid: a pid report that is not a ready report                                                                  |
| process.conversation                | process, conversation (a new conversation id: after /clear, or Pi at its first agent_end)                              |
| process.ended                       | process, reason: exited, limited, restart, move, archived, launch_failed, superseded                                   |
| execution.started                   | process?, typed? (the text typed into the pane)                                                                        |
| execution.accepted                  | execution: the harness took the open execution's input up (its start report, or the runtime saw it working)            |
| execution.ended                     | execution, outcome, failure? {message, kind?: limit}, conversation?, reply? (the harness's reply, when it reported)    |
| inbox.queued                        | kind: task, send or notice, recipient?, sender?, content, status: pending, delivered or dropped, request?, peerItem?   |
| inbox.moved                         | inbox, to, execution? (on to = delivered: the execution that took it)                                                  |
| machine.added, .connected, .removed | name (added: target, vibestd)                                                                                          |
| peer.seen                           | id, name                                                                                                               |
| outbox.queued                       | id, peer, session (the sender), recipient? (the session on the peer; else the sender's origin session), kind?, content |
| outbox.acked                        | peer, ids                                                                                                              |

An execution's input is its typed text, or the inbox rows that moved to delivered with that execution. A delivery opens
the execution before the rows move to delivered, so they get its id. A `task` is handed over with the spawn, before any
execution: its `inbox.moved` is written by the execution it is handed into, at the handover (right before its text
goes), with that execution's id.

A process started before its terminal opens (a spawn, a move to a new terminal) gets `process.placed` once the terminal
is there; it stays one process. Any other start while the session still has a live process first ends that one
`superseded`. One whose terminal never opened ends `launch_failed`, and the session's current process is then the one
before it, if any. Superseded processes are not exits: no reader counts them as one.

An `execution.ended` the harness reported carries its reply (`reply`) and, when it changed, its conversation id; the
projector copies `reply` into the execution's `reply` and the conversation into the current process. An end vibestd
decided (`lost`, `not_started`, an exit, an interrupt it closed) has no `reply`.

A reported end or start is written only for the session's current process: the harness's integration sends the
process id vibestd started it as (`VIBEST_PROCESS`, or the one the ready report's answer gave after an in-place
restart), and a report naming another process is dropped. A reported end is also written only for the harness the
current process runs, and, for a harness whose integration reports ready, only after that process's ready report.
A conversation id or integration version a report carries is recorded under the same process check. An
end that arrives while the open execution is not yet accepted belongs to earlier activity (a Claude background task's
end, for example): it neither closes that execution nor opens another, and its reply is not kept. vibestd's own closes write only while the
execution they decided about is still open, so an end the harness reported first is the one that stands.

Changing the catalog: the catalog holds only the types and keys vibestd writes now. Adding an optional key raises
`CATALOG_VERSION` by one. A type or key that changes meaning or structure, or is no longer written, is retired: it
leaves the catalog, vibestd refuses a file of the older catalog as one from an older vibest and points to the
CHANGELOG, and no old definition stays in the catalog and no projector reads one. A one-time rewrite of existing
ledgers is a manual script kept outside this repository, never part of it. Changing the read model (a column, table,
index or projector rule) raises `PROJECTION_VERSION` instead; a database with another projection version is rebuilt by replaying
its log when it opens, so the read model needs no migration. `packages/schema/test/event-rows.json` holds fixed sample
rows that must keep decoding and re-encoding to the same bytes: add rows to it; only a catalog change that retires a
type or key changes or removes rows, in the same pull request.

## The Db service

- All SQL is in `packages/core/src/database/`, over one SQLite connection. `Db` is the one transaction owner; its interface
  groups its methods by domain (`db.project`, `db.session`, `db.inbox`, `db.remote`), each built by its module
  (`project.ts`, `session.ts`, `inbox.ts`, `remote.ts`) from the in-transaction statements of `session-statements.ts`,
  `inbox.ts` and `remote.ts`. The session row
  callers read (`SessionRow`) is built from the read model plus the memory listed below (`database/ledger-read.ts` holds the
  reads the import's referee shares). It carries `endedAt`, `parentId`, `entry`, the current `process`, the `openExecution` (outcome null) and the `lastExecution` (the most recently ended one); a
  session with neither never ran an execution. `attempts` lists the harness and provider of each of its processes that
  ended `limited`, in process order, once per pair.
- Writes go through intent methods, one per fact: `startProcess` opens a process, except that it reuses a live process
  that has no terminal yet when the harness, provider, model, runtime and routing are identical; `placeProcess` only
  gives the current one its terminal (never a new process id); `startExecution`, `noteConversation`, `rename` and
  `archive` each write their fact when it changes something.
- `commit` runs one transaction and publishes the facts it appended after the commit, in the order it appended them. A nested `commit`
  shares the outer buffer, so only the outermost commit publishes; a rollback publishes nothing. Only the body is
  interruptible: once it has finished, the commit's facts are published before an interrupt lands. The buffer closes
  with its transaction, so a fiber forked inside one must not append.
- `createProject` looks the directory up inside its transaction and creates the project only when none has it: two
  first requests can both miss a lookup made outside it.
- `insertSend` and `archiveIfNoPending` each run in one transaction: a Send accepted before an archive wins, one after
  it is refused. A repeat of a request id returns the row it queued, checked before the archive (it was accepted).
- An entry session moving to another terminal has no place, but its rows wait for it. Rows for an absent entry session are
  dropped only while it still has no place, so a launch that landed in between keeps them.
- A usage-limit move resends the open execution's input (its typed text or the rows it consumed); when that is empty, the
  trailing run of delivered `task` and `send` rows from one sender that no execution consumed, oldest first, joined with a
  blank line.
- A task is queued `delivered` with no execution; one with no `execution_id` was never handed over: the only move a
  task gets is its handover, which names the execution. An execution that ended before its handover (vibestd stopped while
  waiting for ready, or one the user typed meanwhile) took nothing, so the task is still handed over: it is the head
  of the session's queue, an execution end hands it over like a pending row, and an automatic archive waits for it.
- A conversation can be resumed when a process of the session that resumed it or reported it has an ended execution, or,
  for an entry session, when a process of it reported it. The read model keeps only each process's latest
  conversation, so an earlier one in the same process no longer counts.

## Opening and migrations

`packages/core/src/database/migration.ts` opens the file, as OpenCode does:

1. `inspectSchema` reads the file on a read-only connection before it is opened writable. A wrong `application_id`, a
   file that is not empty and has no `migration` table (any shape from before the ledger, v1 included), or one missing
   objects it needs is refused (`SchemaMismatch`) without changing its bytes; the message gives the way out, moving it aside with its `-wal` and `-shm` files while vibestd is
   stopped. A file whose `meta.catalog` is newer than this vibest's catalog is refused with "was written by a newer
   vibest …: run vibest update"; this vibest never skips a fact type it does not know. A file of an older catalog, or
   one with no `meta.ledger` (the event shape before aggregates: one global `seq`, `project_id` and `session_id`
   columns), is refused as a file from an older vibest, with a pointer to the CHANGELOG and the way to start empty.
2. An empty file gets the current schema in one write transaction that checks again under the write lock (so of two
   empty opens at once one installs and the other sees it), with every migration marked applied.
3. Each migration in `migrations` that the `migration` table does not list runs in its own transaction, in order, and
   its id is recorded (`applyOnly`). A migration is a module `packages/core/src/database/migration/<timestamp>_<name>.ts`
   with an `id` and an `up(tx)`, added to `migrations`. The ledger as described here is the baseline, so the list
   starts empty and every later change to the tables is a new migration. `user_version` is not read.
4. In one transaction: when `meta.projection` differs from `PROJECTION_VERSION`, the read model is dropped and rebuilt
   by replaying the log; then `meta.catalog` is set to this vibest's catalog version.
5. `journal_mode = WAL` writes the header, so it is set only after the file is accepted: a refused file keeps its
   database and WAL bytes (its `-shm` may change). `synchronous = NORMAL` cannot corrupt a WAL database; a power loss
   may drop only the last commits, and it saves an fsync per commit.

`vibest update` and `vibest daemon restart` run the new binary's `vibest daemon import-check` (read-only, no lock) before
they change anything. On a ledger it replays the log into a `:memory:` database and, when the projection versions
match, compares every read-model table with the replay; a difference or a fact that does not decode fails it, naming
the first differing row or the fact's aggregate and `seq`. A database from before the ledger, or in the old event
shape, is refused with the same message vibestd gives.
E2E runs it on every world's database at the end of each check.

## Hot paths

- Pending rows: read when a fact for their recipient arrives, and once in a reconcile (at start, when a runtime
  registers or comes back): inbox `WHERE status = 'pending'` through `inbox_status`; the cost does not grow with history. Nothing scans on an interval.
- Open execution of a session: `execution_open`. Live process and pid: `session.process_id`, or `process_live`.
- Session or entry session by terminal: `process_terminal`, joined to `session.process_id` and
  `project.entry_session_id`.
- Usage-limit attempts: the session's processes that ended `limited`, with their harness and provider.
- In-place restart after an update: live sessions (`session_live`), their live process, compare the integration.
  Order: restarting mark in memory, SIGTERM, then `execution.ended` (interrupted) and `process.ended` (restart), then the new
  `process.started`. A refused SIGTERM writes nothing.
- `ls`: sessions by project, the first `task` row, the latest execution and live process as above. `result`: the
  latest ended execution with its `reply`.

## Memory

- One-shot timers (engine): a session's execution-end grace and missed-execution check. Lost with the process; the
  start-up reconcile and `recoverDelivering` stand in for them.
- Live status: from the integration's events (working between `execution.started` and `execution.ended`, plus `blocked`), and
  from the runtime only for a harness with no integration.
- On start, `recoverDelivering` (one transaction) moves every `delivering` row (a message vibestd was typing when it
  stopped) to `failed`, each with an `inbox.moved`, and tells its sender once ("may or may not have arrived"); it is not
  delivered again. A pulled batch is `delivered` and attached to its execution by `take`, so it has no `delivering`
  state; a batch the harness never took up is settled by the execution's confirmation timeout (`not_started`).
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an unended process with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open execution stays open, and the harness's execution end or reconciliation (idle, no result: lost) ends it.
- An execution start an integration reports, or the runtime showing the session working while an execution is open,
  is that execution's `execution.accepted`, written once. An execution end is its `execution.ended` fact, written as
  the hook is admitted (a settlement, so it still lands while vibestd drains). The proof that an execution was taken up
  is its acceptance or its typed text; an inbox row linked into it is not, since a task is linked before the runtime
  gets it.
- The integration version a session's requests carry, until its next `process.ready` records it.
- An entry session moving to another terminal (`vibest` answered y): its rows keep waiting for it.
- `vibest run --archive-on-idle`: the flag is kept only in the memory of the vibestd that started the session (set at
  the spawn, cleared when the session ends), never in a fact or the read model. A session started with it is archived
  the first time it is idle after a completed execution with nothing waiting; once that vibestd stops (a restart,
  `vibest update`), nothing archives it on its own. The builtin plugin `archive-on-idle` is what archives it;
  `"-archive-on-idle"` in `vibest.json` removes the plugin and the flag then does nothing.

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
