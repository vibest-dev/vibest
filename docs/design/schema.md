# Schema

Status: vibestd keeps an append-only log of facts (the `event` table) and an operational read model projected from it, in one SQLite
file, `vibest.db`. Events are defined with `Event.durable` and `Event.ephemeral` (`packages/schema/src/event.ts` and domain
modules `project-event.ts`, `session-event.ts`, `process-event.ts`, `machine-event.ts`, plus the durable manifest in
`durable-event-manifest.ts`); `packages/core/src/bus.ts` appends durable facts and the projectors of
`packages/core/src/project/projector.ts`, `session/projector.ts` and `remote/projector.ts`, each registered with
`bus.project`, turn each into its read-model rows; a replay reaching a fact type with no registered projector fails. The `Db` service
(`packages/core/src/database/db.ts` and its domain modules) answers its callers from the read model and changes nothing but by
appending facts.

- `event`: the log. Each row is one durable fact of one aggregate: `id` (`evt_<12-hex-ms><16-hex-rand>` from `Event.createId`),
  `aggregate_id` (read from the payload field named by `durable.aggregate`), `seq` (monotonically allocated per
  `aggregate_id` via `event_sequence`), `created` (epoch ms), `type` (versioned string `name.version`, e.g.
  `session.created.1`), and `data`, the fact's fields as JSON, written once. `position` is the file's local order of all
  rows; only the bus reads it (to replay, to copy the log, and as the order `Events` reads the whole log in), and no fact
  or read-model row stores it (oxlint rule `vibest/event-reads`).
- `event_sequence`: per-aggregate sequence counter (`aggregate_id`, `seq`) used to allocate `event.seq`.
- Aggregates: a `session` (`sessionId`: every `session.*` and `process.*` fact, including `session.execution.*` and
  `session.inbox.*`), a `project` (`projectId`: `project.*`), a `machine` (`name`: `machine.*`), and a `remote`
  (`remoteId`: `remote.*`, including `remote.outbox.*`). Which aggregate field a type uses is defined by
  `durable: { aggregate: "<field>", version: 1 }` on `Event.durable`.
- `kv`: key-value metadata table (holds `ledger`, a UUID created when the file is initialized).
- `migration`: the ids of the incremental schema migrations applied to this file.
- The read model, one purpose per table: `project`, `project_repository`, `session`, `session_edge`, `process` (one harness
  run of a session), `execution` (one input a session handled until it ended), `inbox` (text for a session, and whether it
  was delivered), `machine` and `remote` (other vibestds), `outbox` (notices waiting for another vibestd).

## Rules

- Record only facts vibest alone knows and cannot read back later: decisions, events it saw, inputs, times. Read
  git, files, the runtime and the configuration when they are needed.
- Every change is a fact appended to the `event` log; the log is never updated, except by a ledger migration at open,
  in the transaction that also rebuilds the read model. Only the projectors and the import
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
remote are two projects. `remote_url` is `remote.origin.url` as git prints it, refreshed on every resolve; nothing matches by it. A directory
with no project is a new project, always. A checkout that moved is moved only by the user's command
`vibest project move <old-directory>`, run inside it: the project recorded at the old directory (which must no longer
exist, with no project recorded here) continues here (`ProjectMoved`: its id kept, its session directories rewritten,
vibest's own worktrees repaired; for the user's worktrees it prints `git worktree repair`). Its
folder is `projects/<project id>/` under `VIBEST_HOME` (preferences.md, docs/, memories/, artifacts/). `vibest ls` and the other
read-only lookups never create one.

vibest's own worktrees are repaired before the move is recorded: a stop in between leaves the project where it was, so
running `vibest project move` again repairs again (nothing left to do) before it records the move. Only worktrees under
vibest's worktrees root are repaired (their `.git` file pointed at the new place, as `git worktree repair` would);
git's own repair would rewrite every worktree of the repository, the user's included.

Agents read and write the project folder with their own file tools; vibestd only names its paths and searches its
text. Search reads every file per query; an index is the next step once a project folder grows past a few hundred
files. The system prompt loads the curated index `memories/MEMORY.md` (trimmed and capped at 100 lines and 8,000 bytes
on a line boundary, with an explicit warning when truncated to compact under 70 lines) rather than enumerating
`memories/*.md`; topic files in `memories/` are read on demand or searched with
`vibest project search <query> --kind memories`, and saving or updating a memory maintains both `memories/<name>.md`
and its one-line entry in `memories/MEMORY.md` (updating or removing stale entries instead of only appending). When
`memories/MEMORY.md` does not exist yet and `.md` files exist in `memories/`, vibest bootstraps `memories/MEMORY.md`
once, sorted by `mtime` descending (deterministic tie-breaker by path), stopping at 70 lines and 5,600 bytes with each
line built from the file's frontmatter `description` (one `description:` line, not a folded YAML block) or first
non-empty line and clipped to 150 characters.

## DDL

```sql
PRAGMA application_id = 1986617957;  -- 0x76696265, "vibe"

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT;
CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT;
CREATE TABLE event (                                  -- the log; append-only
  position     INTEGER PRIMARY KEY AUTOINCREMENT,     -- this file's order; never reused, read only by the bus
  id           TEXT    NOT NULL UNIQUE,               -- evt_<12-hex-ms><16-hex-rand> from Event.createId
  aggregate_id TEXT    NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,                      -- 1, 2, … within the aggregate
  created      INTEGER NOT NULL,                      -- epoch milliseconds
  type         TEXT    NOT NULL,                      -- versioned type: "<name>.<version>" (e.g. "session.created.1")
  data         TEXT    NOT NULL,                      -- the fact's fields, by its definition
  UNIQUE (aggregate_id, seq)
) STRICT;
CREATE INDEX event_aggregate_type_seq ON event (aggregate_id, type, seq);
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
  BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TABLE project (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),  -- UUIDv4, never changed
  directory        TEXT UNIQUE                        -- realpath of the project root; null: imported with none known
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
  origin_remote         TEXT,                         -- started by another vibestd: its id
  origin_project        TEXT,                         -- and its project there
  origin_session        TEXT,                         -- and the session there its notices and sends go to (that project's entry session)
  created_at            INTEGER NOT NULL,
  ended_at              INTEGER,                      -- archived, or replaced by vibest --new
  process_id            INTEGER,                      -- its current process; its latest execution is its highest execution id
  active_at             INTEGER,
  message_id            INTEGER
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE INDEX session_parent  ON session (parent_session_id);
CREATE INDEX session_live    ON session (directory) WHERE ended_at IS NULL;
CREATE INDEX session_origin  ON session (origin_remote, origin_project) WHERE origin_remote IS NOT NULL;

CREATE TABLE session_edge (                           -- directed messaging graph; projected from session.linked / session.unlinked
  from_session_id       TEXT NOT NULL,
  to_remote_id          TEXT NOT NULL DEFAULT '',     -- '' for local sessions, or the target vibestd identity id
  to_session_id         TEXT NOT NULL,
  PRIMARY KEY (from_session_id, to_remote_id, to_session_id)
) STRICT;
CREATE INDEX session_edge_to ON session_edge (to_remote_id, to_session_id);

CREATE TABLE process (                                -- id: explicit per-session processId from process.started
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
  harness_session_id   TEXT,                          -- the harness session id: the one it resumes, then the one it reports
  started_at           INTEGER NOT NULL,
  placed_at            INTEGER,
  ready_at             INTEGER,
  ended_at             INTEGER,
  end_reason           TEXT,
  PRIMARY KEY (session_id, id)
) STRICT;
CREATE UNIQUE INDEX process_live ON process (session_id) WHERE ended_at IS NULL;
CREATE INDEX process_terminal ON process (runtime, terminal) WHERE ended_at IS NULL AND terminal IS NOT NULL;

CREATE TABLE execution (                              -- id: a per-session integer, allocated before start evidence
  session_id TEXT    NOT NULL,
  id         INTEGER NOT NULL,
  process_id INTEGER,
  typed      TEXT,                                    -- direct input typed into the pane; none for a delivery
  booked_at  INTEGER NOT NULL,                        -- when the id was allocated
  started_at INTEGER,                                 -- null until start evidence; null on an end-only row
  outcome    TEXT CHECK (outcome IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),  -- null: unknown or live
  failure    TEXT,
  failure_kind TEXT CHECK (failure_kind IN ('limit')),  -- limit: the harness hit its usage limit
  reply      TEXT,                                    -- text the terminal event carried; null: none
  ended_at   INTEGER,
  owner      INTEGER NOT NULL DEFAULT 0,              -- 1: the session's active execution
  PRIMARY KEY (session_id, id)
) STRICT;
CREATE UNIQUE INDEX execution_open ON execution (session_id) WHERE owner = 1;

CREATE TABLE inbox (                                  -- id: explicit per-session messageId from session.inbox.enqueued
  recipient_session_id    TEXT    NOT NULL,            -- the recipient
  id                     INTEGER NOT NULL,
  sender_type            TEXT    NOT NULL CHECK (sender_type IN ('agent', 'plugin', 'vibest', 'user')),
  sender_session_id      TEXT,
  sender_agent           TEXT,
  sender_title           TEXT,
  sender_machine         TEXT,
  sender_plugin          TEXT,
  sender_key             TEXT    NOT NULL,
  about_session_id       TEXT,                        -- a notice: the session it is about, else null
  content                TEXT    NOT NULL,
  request_id             TEXT,
  transfer_id            TEXT,                        -- a cross-machine transfer: the sender's existing item id, else null
  status                 TEXT    NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
  sender_execution_id    INTEGER,                     -- a local agent send: the sender's open execution, else null
  recipient_execution_id INTEGER,                     -- delivered: the recipient execution that took it
  PRIMARY KEY (recipient_session_id, id)
) STRICT;
CREATE INDEX inbox_status    ON inbox (status, recipient_session_id);   -- full index on purpose: a partial IN (...) index is not used for status = 'pending'
CREATE INDEX inbox_sender    ON inbox (sender_session_id) WHERE sender_session_id IS NOT NULL;
CREATE INDEX inbox_about     ON inbox (about_session_id) WHERE about_session_id IS NOT NULL;
CREATE INDEX inbox_recipient_execution ON inbox (recipient_session_id, recipient_execution_id) WHERE recipient_execution_id IS NOT NULL;
CREATE UNIQUE INDEX inbox_request ON inbox (sender_key, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX inbox_transfer ON inbox (transfer_id) WHERE transfer_id IS NOT NULL;
```

`machine`, `remote` and `outbox` are in [multi-machine.md](multi-machine.md). There are no foreign keys and no other
triggers: the projectors keep the read model whole, and one live process and one open execution per session are
unique indexes, so a fact that would break them fails its transaction.

## Inbox

An inbox row is text for one recipient session (`recipient_session_id`); its id is the explicit `messageId` carried by
its `session.inbox.enqueued` fact, so a row is named by both. A session's original delegation is the message
named by `session.message_id`, written in the same transaction as `session.created`; `result` and `vibest ls` follow
that, not the earliest row. A notice is from `vibest` and may name `about_session_id`. Anything else is an ordinary
message.

- The `session.inbox.enqueued` `sender` is one tagged value: `{type: "agent", session, agent?, title?, machine?}` (`machine` set
  when it was received from another vibestd), `{type: "plugin", plugin}`, `{type: "vibest"}` (every notice) or
  `{type: "user"}` (a send or task with no session). The row keeps the tag in `sender_type` and each field in its own
  column; a local agent sender has `sender_session_id` set and `sender_machine` null, and `about_session_id` is a
  notice's `about`. `sender` is whoever wrote the message: a relay to the nearest living ancestor on this machine passes
  the message on unchanged and keeps the sender, while one that goes on to another machine writes a new message
  (prefixed with the incoming address) from the ended recipient's session, which is then its sender there.
- A `request_id` repeats nothing: one sender (`sender_key`) queues one row per request, whatever the recipient, so a
  repeat that a relay sends elsewhere is still one message, and the same request from another sender is its own. The
  unique index `inbox_request` backs it: a second row would fail its transaction.
- A send from a local agent session names the execution it had open (`senderExecutionId` on `session.inbox.enqueued`,
  `execution` on `remote.outbox.queued`). `ctx.session.sentIn` counts those rows, including an outbox row whose session has
  since ended or been acknowledged, without counting the original delegation. Ending a session does not delete the
  outbox row; a remote is not offered rows for an ended session. It is not evidence the recipient was handed the message.
  A send forwarded straight to a session on another machine writes no local inbox fact and is not counted. A
  cross-machine transfer reuses the sender's existing item id as `transferId`; a local message leaves it empty. An
  outbox acknowledgement means the remote accepted the item, not that the agent was handed it.
- An execution end writes no inbox row. The recipient of a `notice` is `parent_session_id` while it lives, then the entry
  session, then `origin_session` through the outbox; an undeliverable `send` notifies its sender.

## Facts

`packages/schema/src/event.ts` provides `Event.durable` and `Event.ephemeral`. The 31 durable event definitions live in
domain modules (`project-event.ts`, `session-event.ts`, `process-event.ts`, `machine-event.ts`) and are registered in
`packages/schema/src/durable-event-manifest.ts` (22 public domain types in `PublicEvents` for plugin subscriptions, plus
9 internal process/bookkeeping/transport types: `process.started`, `process.updated`, `process.ready`, `process.ended`,
`session.inbox.delivering`, `machine.connected`, `remote.seen`, `remote.outbox.queued`, `remote.outbox.acked`). Each
durable definition carries `durable: { aggregate: "<field>", version: 1 }` (stored as `versionedType = "<name>.<version>"`)
and a `schema`. `Bus.publish` reads `aggregate_id` from `data[def.durable.aggregate]` — every entity id
(`projectId`, `sessionId`, `processId`, `messageId`, `remoteId`) is explicit inside `data`. A key marked optional is absent,
never null, and a string key that is present is never empty. Encoding and decoding refuse keys a definition does not have,
and encoding fails when its JSON does not decode back. `Routing` and `TraceEntry` (with `Change`) from
`packages/schema/src/plugin.ts` are part of the event contract through `process.started.routing`: change them by the same
rules as a fact.

| type                                | data                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| project.created                     | projectId, directory?, repositories                                                                                                                                            |
| project.moved                       | projectId, from, to, repositories                                                                                                                                              |
| project.repositories_changed        | projectId, repositories                                                                                                                                                        |
| session.created                     | sessionId, project, agent, name, directory, parent?, origin? {remote, project, session?}, messageId? (the original delegation messageId)                                       |
| session.linked                      | sessionId, to, remote? (target session id and optional remote vibestd id for directed messaging edge from this session)                                                        |
| session.unlinked                    | sessionId, to, remote? (target session id and optional remote vibestd id removed from directed messaging edges of this session)                                                |
| session.renamed                     | sessionId, name                                                                                                                                                                |
| session.directory_changed           | sessionId, directory                                                                                                                                                           |
| session.archived                    | sessionId                                                                                                                                                                      |
| process.started                     | sessionId, processId, harness, provider?, model?, routing?, resume?, runtime, terminal?, pid? (an entry session's launch)                                                      |
| process.updated                     | sessionId, processId, terminal?, pid?, conversation?: patches terminal placement, pid, or harness conversation id                                                              |
| process.ready                       | sessionId, processId, pid?, integration? {version, protocol}; may repeat after a plugin reload                                                                                 |
| process.ended                       | sessionId, processId, reason: exited, restart, move (an entry session moving terminal), archived, launch_failed, superseded, stopped; by? (stopped: who stopped it, a sender)  |
| session.execution.allocated         | sessionId, executionId, processId?, typed? (direct input; not an inbox message). Allocating this id is not a start.                                                            |
| session.execution.started           | sessionId, executionId, processId?. Only with attributable start evidence.                                                                                                     |
| session.execution.succeeded         | sessionId, executionId, reply?. The run ended normally. Not task acceptance and not a message sent.                                                                            |
| session.execution.failed            | sessionId, executionId, failure {message, kind?: limit, resetAt?}, reply?. Only a confirmed error.                                                                             |
| session.execution.interrupted       | sessionId, executionId, reason?, reply?. A stop request is not this event.                                                                                                     |
| session.execution.unresolved        | sessionId, executionId, observation: lost or not_started, failure?, reply?. Timeout or disconnect. Not a confirmed failure; a later terminal event for this id still applies.  |
| session.execution.input             | sessionId, executionId, typed. Additional direct input submitted while an execution is open.                                                                                   |
| session.inbox.enqueued              | sessionId, messageId, sender, content, senderExecutionId?, requestId?, transferId?, aboutSessionId? (a notice). Starts pending; the event carries no status                    |
| session.inbox.delivering            | sessionId, messageId, execution? (the reserved recipient execution when one is open). A reservation, not delivery, and not written again for each wait                         |
| session.inbox.delivered             | sessionId, messageId, recipientExecutionId. Both required: handed as that execution's input                                                                                    |
| session.inbox.failed                | sessionId, messageId, reason. A recorded failure, not an unknown result                                                                                                        |
| session.inbox.dropped               | sessionId, messageId, reason. Local delivery responsibility ended (the entry session left, a waiting message withdrawn)                                                        |
| machine.added, .connected, .removed | name (added: target, remote)                                                                                                                                                   |
| remote.seen                         | remoteId, name                                                                                                                                                                 |
| remote.outbox.queued                | id, remoteId, session (the sender), recipient? (the session on the remote; else the sender's origin session), kind?, content, execution? (a send: the sender's open execution) |
| remote.outbox.acked                 | remoteId, ids                                                                                                                                                                  |

An execution's input is its typed text, or the inbox rows delivered into that execution. A delivery opens the
execution and then writes `session.inbox.delivered` with that execution's id, once the text is its input. Launch arguments are
only how the original delegation is carried; it is not delivered until that write. A second message that arrives while
the delegation is still waiting stays pending and is not part of that execution.

A process started before its terminal opens (a spawn, a move to a new terminal) gets `process.updated` once the terminal
is there; it stays one process. Any other start while the session still has a live process first ends that one
`superseded`. One whose terminal never opened ends `launch_failed`, and the session's current process is then the one
before it, if any. Superseded processes are not exits: no reader counts them as one.

A `session.execution.succeeded` the harness reported carries its reply. A changed conversation id is a `process.updated`,
not an execution field. An execution vibestd gives up (`session.execution.unresolved`: `lost` or `not_started`) is not a
confirmed result: it frees the one live slot, and a later report that names that execution still lands on it.
There is no stored send count. `sentIn` counts the `inbox` and `outbox` send rows for that execution, so ending the
session does not change it. A machine-addressed send is forwarded and records no execution, so it adds nothing. One
row has `owner = 1`. A successor's `session.execution.started` clears the previous owner and does not invent its outcome. An end report settles an execution only when it names that execution. The reply text is not an identity: a later
execution finishes from its own report even when the reply matches an earlier one, and a retry that names the earlier
execution changes nothing. A report that names no execution is not applied. Claude and Pi send the execution id they
already knew; Cursor and agy cannot, so their end report does not choose an execution.

A report that names an execution is written on that execution and leaves a successor and the session unchanged. The harness's integration sends the
process id vibestd started it as (`VIBEST_PROCESS`, or the one the ready report's answer gave after an in-place
restart), and a report naming another process is dropped. A reported end is also written only for the harness the
current process runs, and, for a harness whose integration reports ready, only after that process's ready report
unless the report names the current process: the integration sends its ready report on its own, so under load an
execution's end can arrive before the ready report is written, and a report naming the current process is already
known to come from it.
A conversation id or integration version a report carries is recorded under the same process check. An
end that arrives while the open execution is not yet accepted belongs to earlier activity (a Claude background task's
end, for example): it neither closes that execution nor opens another, and its reply is not kept. vibestd's own closes write only while the
execution they decided about is still open, so an end the harness reported first is the one that stands.

Changing event definitions or tables: durable events are versioned (`"<name>.<version>"`). Adding an optional field keeps
the schema backward-compatible. Adding a table, column, or index uses an incremental migration in
`packages/core/src/database/migration/`. `packages/schema/test/event.test.ts` covers event encoding, decoding, and
manifest round-trips.

## The Db service

- All SQL is in `packages/core/src/database/`, over one SQLite connection. `Db` is the one transaction owner; its interface
  groups its methods by domain (`db.project`, `db.session`, `db.inbox`, `db.remote`), each built by its module
  (`project.ts`, `session.ts`, `inbox.ts`, `remote.ts`) from the in-transaction statements of `session-statements.ts`,
  `inbox.ts` and `remote.ts`. The session row
  callers read (`SessionRow`) is built from the read model plus the memory listed below (`database/ledger-read.ts` holds the
  reads the import's referee shares). It carries `endedAt`, `parentId`, the current `process`, the `openExecution` (outcome null) and the `lastExecution` (the most recently ended one); a
  session with neither never ran an execution.
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
- `insertSend` and `archive` each run in one transaction: a Send accepted before an archive wins, one after
  it is refused. A repeat of a request id returns the row it queued, checked before the archive (it was accepted).
- An entry session moving to another terminal has no place, but its rows wait for it. Rows for an absent entry session are
  dropped only while it still has no place, so a launch that landed in between keeps them.
- The original delegation stays pending until `session.inbox.delivered` names the recipient execution. Until then it is the
  head of that session's queue. A message with no recipient execution was not handed over.
- A conversation can be resumed when a process of the session that resumed it or reported it has an execution that
  was accepted (the harness has taken an input in it) or has ended, or,
  for an entry session, when a process of it reported it. The read model keeps only each process's latest
  conversation, so an earlier one in the same process no longer counts.

## Opening and migrations

`packages/core/src/database/migration.ts` and `packages/core/src/database/db-schema.ts` open the file, as OpenCode does:

1. `inspectSchema` reads the file on a read-only connection before it is opened writable. A wrong `application_id`, a
   non-empty file with an older pre-v2 layout (missing `kv`, `event_sequence`, or `event.aggregate_id`), or one missing
   objects it needs is refused (`SchemaMismatch`) without changing its bytes; the message gives the way out, moving it
   aside with its `-wal` and `-shm` files while vibestd is stopped. A file whose `migration` table records an id unknown
   to this vibest is refused with "was migrated by a newer vibest (migration …): run vibest update".
2. An empty file gets the current schema in one write transaction that checks again under the write lock (so of two
   empty opens at once one installs and the other sees it), with every built-in migration marked applied and a fresh
   `kv.ledger` UUID.
3. On reopen when all migrations are already applied, opening is O(1) — no drop-and-replay occurs. When pending
   migrations exist, one write transaction runs each unapplied migration in `migrations` in order with the
   `event_no_update` trigger lifted, records its id in `migration`, and restores the trigger. Any failure rolls all of it
   back, trigger included.
4. An incremental migration is a module `packages/core/src/database/migration/<timestamp>_<name>.ts` with an `id` and an
   `up(tx)`, added to `migrations`. It modifies SQLite tables incrementally (`ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`,
   backfills) and imports only `effect`, never the event schema (an oxlint rule on the folder). There are no down
   migrations and `user_version` is not read.
5. `journal_mode = WAL` writes the header, so it is set only after the file is accepted: a refused file keeps its
   database and WAL bytes (its `-shm` may change). `synchronous = NORMAL` cannot corrupt a WAL database; a power loss
   may drop only the last commits, and it saves an fsync per commit.

`vibest update` and `vibest daemon restart` run the new binary's `vibest daemon import-check` (read-only, no lock) before
they change anything. It copies the log and `kv` into a `:memory:` database, replays every event through the current
projectors, and compares every read-model table against the source file; a difference, or a fact that does not decode or
whose projector fails, fails it, naming the first differing row or the fact's aggregate and `seq`. E2E runs it on every
world's database at the end of each check.

## Hot paths

- Pending rows: read when a fact for their recipient arrives, and once in a reconcile (at start, when a runtime
  registers or comes back): inbox `WHERE status = 'pending'` through `inbox_status`; the cost does not grow with history. Nothing scans on an interval.
- Open execution of a session: `execution_open`. Live process and pid: `session.process_id`, or `process_live`.
- Session by terminal: `process_terminal`, joined to `session.process_id`.
- In-place restart after an update: live sessions (`session_live`), their live process, compare the integration.
  Order: restarting mark in memory, SIGTERM, then `process.ended` (restart); the execution is not given a result by the restart, then the new
  `process.started`. A refused SIGTERM writes nothing.
- `ls`: sessions by project, the first `task` row, the latest execution and live process as above. `result`: the
  latest ended execution with its `reply`.

## Memory

- One-shot timers (engine): a session's execution-end grace and missed-execution check. Lost with the process; the
  start-up reconcile stands in for them.
- Live status: from the integration's events (working between `session.execution.started` and a terminal execution event, plus `blocked`), and
  from the runtime only for a harness with no integration.
- On start, a `delivering` row (a hand-over that started and was not confirmed) stays `delivering`. It is not
  delivered again, it is not recorded as a failure, and it does not keep the daemon from stopping: the result is
  unknown. `take` and the launch arguments only reserve the batch (`session.inbox.delivering`). Delivery is the
  integration reporting that this execution's input was submitted, or a typed send that both wrote the batch and
  was accepted. A session that never launches does not receive its first message.
- Restarting mark: the end events are written after SIGTERM, so a crash before it leaves the old process running,
  and a crash after it leaves an unended process with no harness in the pane, which reconciliation ends.
- Skipped options within one harness change, per-session locks, paste and ack waits: lost with the process; an
  open execution stays open, and the harness's execution end or reconciliation (idle, no result: lost) ends it.
- An execution start an integration reports, or the runtime showing the session working while an execution is open,
  is that execution's `session.execution.started`, written once. An execution end is `session.execution.succeeded`, `session.execution.failed`
  or `session.execution.interrupted`, written as the hook is admitted (a settlement, so it still lands while vibestd drains).
  The proof that an execution was taken up is that start or its typed text; an inbox row linked into it is not, since a
  task is linked before the runtime gets it.
- The integration version a session's requests carry, until its next `process.ready` records it.
- An entry session moving to another terminal (`vibest` answered y): its rows keep waiting for it.

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
