# Runtime-neutral identity

Status: draft. Breaking: `omac.db` is redesigned from scratch; there is no migration from the current layout.

## Glossary

| Term            | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **harness**     | The CLI program type a session runs: `claude`, `codex`, `pi`, `cursor`.                                                                                                                                                                                                                                                                                         |
| **agent**       | A definition a session is started from: a name and a system prompt (later perhaps a default harness, model, tools), as in Claude Code's `.claude/agents` or OpenCode's `--agent`. Built in: **`coordinator`** and **`general`**. User-defined agents (planner, reviewer, …) are future work (`omac run --agent <name>`); this design only leaves room for them. |
| **coordinator** | The built-in agent with special rights: launched by `omac launch`, one identity per repository (the **project**), directs other sessions, owns them, receives their results; read-only otherwise. (Not "supervisor": `plugins.ts` already has a plugin supervisor.)                                                                                             |
| **general**     | The built-in default agent: a session started to do work (what used to be called a Worker).                                                                                                                                                                                                                                                                     |
| **session**     | A running instance omac started with a harness and an agent: an id, a location (runtime + address), state and an inbox. Its harness's own conversation id is `harness_session_id`.                                                                                                                                                                              |
| **runtime**     | Where sessions live: `herdr` today. herdr's own "session" appears only inside an `address` and in `runtime/herdr.ts`.                                                                                                                                                                                                                                           |

Reserved agent names: `coordinator` and `general` are built in and reserved. A user definition with a reserved name
(e.g. `.omac/agents/coordinator.md`, once user-defined agents exist) does not create a new agent; it customizes the
built-in one — its system prompt replaces the built-in prompt — and the session's `agent` stays the reserved name. The
coordinator's rights stay tied to `agent = 'coordinator'`, a value only `omac launch` writes (`coordinatorLaunch`);
`omac run --agent coordinator` (and a `Spawn` with `agent: "coordinator"`) is rejected. So every
`WHERE agent = 'coordinator'` in this design stays correct whatever definitions a user adds.

"Worker" is retired: every user-visible use becomes "session" (§5).

Casing: these terms are common nouns, lowercase in prose — docs, SPEC, rules and prompts, CLI help, error and notice
messages ("the coordinator", "a session"), as PR #43 already did for "agents". Agent names are values
(`coordinator`, `general`). Identifiers follow their language's conventions (`Coordinator` in a TS tag,
`coordinatorLaunch`, `OMAC_SESSION_ID`).

## 0. Problem and model

Today a coordinator's identity is the string `pane:<herdr session>/<pane id>`, used as owner in `worker.caller_id` and as
receiver/sender in `inbox`. A new pane (relaunch) is a new owner, so a relaunched coordinator loses its sessions; the
schema also hard-wires herdr (`worker.herdr_session`, `pane:` strings parsed back by `Inbox.deliver`).

Decided model:

- **Identity is an omac id, independent of the runtime.** The coordinator's identity is the **project** (one per
  repository). Every session started to do work belongs to its project's coordinator, whoever started it
  (the coordinator or the command line); the command line can manage every session on the machine.
- **Every session row names its agent** (`coordinator`, `general`, later user-defined). Coordinator-only behaviour keys
  on `agent = 'coordinator'`; every other session behaves alike.
- **Location** = `runtime` + `address` (runtime JSON), on every session row. **A project has one coordinator
  session row**, with a stable id; `omac launch` points it at the pane it execs in and at the harness it runs. That row
  is the active coordinator by construction: nothing to mark, nothing decided by time.
- A process knows its session from one variable, `OMAC_SESSION_ID`, never by asking the runtime (§6).

`omac launch claude` and later `omac launch pi` in one repository are the same coordinator: same session id, same
sessions, same inbox. Switching harness starts a new conversation (the row holds one harness's conversation); switching
back later starts another new one — accepted.

omac does not stop two coordinator processes of one repository from running at once, as Claude Code and Pi do not
stop two instances of one session: omac follows the harnesses. A process of an earlier launch that is still running
keeps its identity — it is still this repository's coordinator, may run `omac` (list, send, run) and sees the same
sessions — but omac prompts only the row's address, so it receives no prompted deliveries. Its session reports still
count (last report wins, §1.2). `omac launch` warns about it and offers to stop it, never closing its pane (§1.2
"A coordinator still running").

## 1. Schema

`db.ts` has one schema. An empty database — `sqlite_master` has no rows (a new file) — gets it in one transaction, version
pragmas included; a failure rolls that back and leaves the file empty. Any other database is accepted only when
`PRAGMA application_id` is omac's (`0x6F6D6163`, "omac"), `PRAGMA user_version` is `SCHEMA_VERSION` (1), and the v1
tables and indexes are present, including unique partial `session_coordinator`. Everything else — today's `omac.db`
(application_id 0, user_version 3), an older or newer one, a foreign file, a partial v1 — fails at omacd start with
`SchemaMismatch` and is not modified or repaired: `omac.db is not this omac's schema (application_id 0x<id>, v<n>[, <gap>]);
stop omacd and move ~/.omac/omac.db away to start over`. A wrong `application_id` is named even when `user_version` is
already 1. An existing file is inspected on a read-only connection, which can see committed WAL frames, before any
writable open. A mismatch never opens writable, so the database file and its WAL are not checkpointed. A read-only open
may rewrite the WAL index (`-shm`); that file is not part of the byte guarantee. WAL mode is turned on only after
acceptance. `SchemaTooNew` and
`MIGRATIONS` are deleted. (`application_id` is what keeps an old v1 file from passing the version check.) `startDaemon`
surfaces it: when the omacd it started exits before its socket
appears, it fails with the last `<Tag>: <message>` line of `omacd.log` instead of waiting out the timeout with "omacd did
not come up; see omacd.log".

```sql
PRAGMA application_id = 0x6F6D6163;
PRAGMA user_version = 1;

CREATE TABLE project (
  id             INTEGER PRIMARY KEY,
  repository_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE session (
  id                 TEXT PRIMARY KEY CHECK (length(id) = 8 AND id NOT GLOB '*[^0-9a-f]*'),
  project_id         INTEGER NOT NULL REFERENCES project (id),
  agent              TEXT NOT NULL,
  harness_id         TEXT NOT NULL,
  harness_session_id TEXT,
  runtime            TEXT,
  address            TEXT,
  -- every other agent
  name               TEXT,
  provider           TEXT,
  model              TEXT,
  status             TEXT,
  turn_state         TEXT,
  turn_prompted_at   INTEGER,
  turn_prompted_seq  INTEGER,
  metadata           TEXT,
  created_at         INTEGER,
  last_active        INTEGER,
  CHECK ((runtime IS NULL) = (address IS NULL)),
  CHECK (agent = 'coordinator'
    OR (runtime IS NOT NULL AND name IS NOT NULL
      AND status IS NOT NULL AND turn_state IS NOT NULL AND turn_prompted_at IS NOT NULL
      AND turn_prompted_seq IS NOT NULL AND metadata IS NOT NULL AND created_at IS NOT NULL AND last_active IS NOT NULL))
) STRICT;
CREATE INDEX session_project ON session (project_id);
CREATE UNIQUE INDEX session_coordinator ON session (project_id) WHERE agent = 'coordinator';
CREATE UNIQUE INDEX session_address ON session (runtime, address) WHERE agent = 'coordinator';

CREATE TABLE inbox (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session (id),
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX inbox_session ON inbox (session_id, kind, status);
CREATE INDEX inbox_waiting ON inbox (session_id) WHERE status = 'pending' AND kind != 'send';
```

`PRAGMA foreign_keys = ON` per connection, as today. Nothing deletes rows (§1.3 "Kept forever"), so the foreign keys
have no `ON DELETE` action: a delete that would leave a session without its project, or an inbox row without its
session, fails.

What the database checks, and what it leaves to the Schema decode:

- **Structural CHECKs stay**: the id format, the columns each side needs, and `runtime` / `address` set or unset
  together. (Nothing forbids the other side's columns; the two inserts leave them NULL.)
- **Value lists are not CHECKed**: `session.status`, `session.turn_state`, `inbox.kind` and `inbox.status` are
  validated by the Schema decode in `db.ts` (`InboxStatus`, …), like `agent` and `harness_id`. There is no
  migration, so a new value in a CHECK would force every user to delete `omac.db`; in the decode it is a code change.
- **No `json_valid`**: `address`, `metadata` and `details` are written only through Schema encoders.
- **`STRICT`** on every table: a value of the wrong storage class is an error, not a silent conversion. Booleans are
  bound as `0` / `1` (`:fresh`).
- **Session ids**: 8 lowercase hex, random, never reused (rows are never deleted). A draw that collides with an
  existing id fails the insert (primary key), which retries with a new draw.
- **Inbox rows only for non-coordinator sessions**: kept in application code (the three insert paths, §1.3), each
  covered by a test that its row references a non-coordinator session; no trigger.

Concurrency: `@effect/sql-sqlite-bun` uses one connection; every statement is serialised (`Semaphore(1)`),
transactions are `BEGIN IMMEDIATE`, the journal is WAL. Races exist only across "read → await the runtime → write"
flows; those are closed by guarding each write on the state it expects (inbox status transitions and the coordinator
read, below).

### 1.1 `project` — the coordinator identity

One row per repository; `id` is the coordinator's identity and every ownership check compares it. `repository_key`
(SPEC §4) finds the row; a changed key (new remote, `OMAC_PROJECT_ID`) makes a new project, as today.
Written: `Db.projectId(key)` (get-or-create) from `coordinatorLaunch` and `insertSession`.
Read: the same, plus `Spawn`'s check that a coordinator's repository header is its own project (§2).
Dropped: `created_at` (nothing reads it).

### 1.2 `session` — every session omac starts

One row per session. `agent` is the agent it was started from: `coordinator`, `general`, or (later) a user-defined
name; it is not constrained to a list, so user-defined agents need no schema change. `coordinator` is written only by
`coordinatorLaunch`; `insertSession` never writes it (reserved names, Glossary). The CHECK requires only what a
non-coordinator session needs: its location and state (`runtime` set implies `address` set, by the pairing CHECK); a
coordinator row needs nothing beyond the NOT NULL columns. The other side's
columns are left NULL by the two inserts (`coordinatorLaunch`, `insertSession`); no column defaults.

- `id`: 8 hex for every session, never reused; it is the
  value of `OMAC_SESSION_ID` (§6). For a non-coordinator
  session it also names the runtime agent (`s-<id>`), the worktree, the rules and result files, and is what the CLI
  takes (`omac send <id>`).
- Coordinator session: **one row per project** (partial unique index `session_coordinator`), created by the first
  `omac launch` in the repository and reused by every later one: same id, so `OMAC_SESSION_ID` is stable across
  relaunches and harness switches. It is the active coordinator; delivery and `Inbox.Subscribe` read it directly.
- No process id is stored. An earlier launch's process still running carries the same `OMAC_SESSION_ID`; it keeps
  the identity but is not at the row's address, so it is never prompted (§0).

| Column                                                          | Side  | Written by                                                                                                                                                                                                                                       | Read by                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`, `agent`, `harness_id`                             | both  | `insertSession`, `coordinatorLaunch` (a coordinator's `harness_id` changes on a harness switch)                                                                                                                                                  | caller headers (which side), List / `managed()` / inbox scope; launch and resume args                                                                                                                                                    |
| `harness_session_id`                                            | both  | session: spawn (Pi / Claude choose it), `check` / `collectResult` (Codex / Cursor report it). Coordinator: `reportCoordinatorSession`; cleared by `coordinatorLaunch` with `--new` or a harness switch                                           | session `resume`; `coordinatorLaunch` (conversation to reopen)                                                                                                                                                                           |
| `runtime`, `address`                                            | both  | session: spawn (`{"session":"default"}`; the harness is addressed by name `s-<id>` in it). Coordinator: only `coordinatorLaunch` and runtime events: pane moved (`moveCoordinator`), pane closed (`clearCoordinator`). Not from a request header | session: `pool.client(address.session)` in `check` / `deliver` / `interrupt` / `remove` / recovery, `workspace_closed` routing. Coordinator: delivery (`coordinatorOf(project)`), runtime idle / closed / moved events (`coordinatorAt`) |
| `name`, `provider`, `model`                                     | other | spawn                                                                                                                                                                                                                                            | launch / resume args, `SessionInfo`                                                                                                                                                                                                      |
| `status`, `turn_state`, `turn_prompted_at`, `turn_prompted_seq` | other | the state machine (SPEC §8); `turn_prompted_seq` is the runtime's state counter at prompt time                                                                                                                                                   | the same                                                                                                                                                                                                                                 |
| `metadata` JSON                                                 | other | spawn, `remove`                                                                                                                                                                                                                                  | `env` (resume), `routing` (`SessionInfo`), `removed` (`check`, `deliver`, `send`), `stop` (the runtime's removal records, SPEC §8.6a, opaque outside the runtime module)                                                                 |
| `created_at`, `last_active`                                     | other | spawn, every state change                                                                                                                                                                                                                        | `SessionInfo`, list order                                                                                                                                                                                                                |

`coordinatorLaunch(project, harness, { fresh, location })`, one transaction:

```sql
UPDATE session SET runtime = NULL, address = NULL
WHERE agent = 'coordinator' AND runtime = :runtime AND address = :address AND project_id != :project
RETURNING project_id;                                   -- each: dropWaiting(project_id)

INSERT INTO session (id, project_id, agent, harness_id, runtime, address)
VALUES (:newId, :project, 'coordinator', :harness, :runtime, :address)
ON CONFLICT (project_id) WHERE agent = 'coordinator' DO UPDATE SET
  harness_session_id = CASE WHEN :fresh OR session.harness_id != excluded.harness_id THEN NULL
                            ELSE session.harness_session_id END,
  harness_id = excluded.harness_id,
  runtime = excluded.runtime, address = excluded.address
RETURNING id, harness_session_id;

-- dropWaiting(:project), below
```

`:newId` is a fresh 8-hex id, used only on the project's first launch. Same harness: the conversation is kept (cleared
only with `--new`). Different harness: same row and id, `harness_id` replaced, conversation cleared. The location is
always set: `omac launch` execs the harness only in a herdr pane (elsewhere it opens a tab whose shell runs `omac launch`
again), so a launched coordinator always has an address. Taking it at launch means results go to the new pane at once,
not when the new coordinator first runs `omac`. `address` is written only through the runtime's Schema encoder, so equal
locations are equal strings. One place holds one coordinator: the first statement takes the address away from another
project's coordinator row still pointing at this pane (its harness exited and the pane now runs this launch; a missed
`pane_closed` or a reused pane id), and `session_address` is UNIQUE, so `coordinatorAt(address)` (the project whose
coordinator is at a pane) returns at most one row. All of it is one transaction: the address taken from another project
drops what was waiting for that project's coordinator, and the launch drops what was waiting for this project's
previous one (`dropWaiting`, §Delivery).

**A coordinator still running.** A project has one main agent. Before `Project.CoordinatorSession`, `vibest`
(`soleMainAgent`, `cli.ts`) asks `Project.RunningCoordinator { terminal }`. vibestd answers `{ harness, place, runtime,
address }` when the project's coordinator row has an address other than the launching terminal and
`coordinatorIdle(address)` is `idle` or `busy`; otherwise null (no row, no address, the launching terminal itself,
`gone`, `unknown`). On an answer, when `interactive` (stdin and stdout are terminals), `vibest` asks
`The main agent (<harness>) runs in <place>. Move it here and continue? [y/N]` (`askYesNo`, two minutes):

| Answer                                   | Then                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `y`                                      | `Project.StopCoordinator { runtime, address }` (`stopAgent`, below). `stopped` → start here. `running` (not stopped; nothing changed), `unsupported` (says why) or `moved` → fail without starting (no exec) |
| `N`, empty, EOF, timeout, not a terminal | fail without starting, naming where it runs and saying to exit it there first                                                                                                                                |

`vibest` execs the harness, so its own PID is the harness's: it passes `pid` to `Project.CoordinatorSession`, which
keeps it on the main session (`metadata.pid`). `stopAgent` ends that harness and nothing else: SIGTERM to that one
PID, never its process group (a terminal vibest opened runs `sh -c '"$@"; exec $SHELL'`, `vibest` included, in one
group) and never the terminal, then signal 0 until it exited, at most 10 s. The terminal and its shell stay. Before the
signal the row leaves its place (`detachCoordinator`: no address, `metadata.moving`), so the harness's exit (the
runtime's `exited`) clears nothing and drops nothing, and a delivery round in between keeps what waits for it
(`dropWaiting`'s `absent` guard skips a moving main agent). A harness still there after 10 s, or a refused signal, puts
the row back (`reattachCoordinator`): `running`, nothing changed. From the detach to the answer the stop is uninterruptible (at most 10 s), so a client that goes away (Ctrl-C) cannot leave the row detached while the harness still runs. An exited PID needs no signal: the row detaches,
`stopped`. Nothing is signalled, and the answer is `unsupported` with a reason the CLI prints ("cannot be moved from
here: <why>. Exit it there first"), on another machine, with no PID recorded (started by an older vibest), or when the
runtime sees no agent there while the PID is alive (it may be another program now). The launch that follows keeps the waiting rows
(`coordinatorLaunch` does not drop them for a moving main agent) and the main session id; the same harness resumes the
same conversation (`--resume`), another harness starts a new one for that harness, as a harness switch does. Signalled
only while the runtime sees an agent in that terminal; with none there, an exited PID means the harness is already gone
(the row moves without a signal), anything else (a program of the user's, a reused PID) is left alone (`running`).

vibestd enforces one main agent, since every start goes through it: `Project.CoordinatorSession` from another terminal
while `Project.RunningCoordinator` would answer is refused (`Forbidden`) and changes nothing. The running check and the
launch, and the stop, hold one in-process lock per project (one vibestd serves every request), so two starts at once
cannot both pass. It is not a sqlite row: the stop waits on the runtime for up to 10 s, and a row would outlive a crash.
A project's lock is dropped once nobody holds or waits for it.

Limits: local machine only (a PID names a process on vibestd's machine; a remote machine needs a runtime operation); a
main agent started by an older vibest has no PID recorded and cannot be moved (exit it there); the check fails open (a
runtime that cannot be reached or cannot tell counts as not running); a PID reused by another program while the runtime
still sees an agent in that terminal would get the signal; when the harness exited and vibestd missed it, a program of
the user's in that pane reads `busy`, and the move answers `running` unless the recorded PID has exited.

`moveCoordinator(runtime, from, to)` (herdr `pane_moved`) keeps the same rule, in one transaction. It returns at once when `from = to` (otherwise the first statement would
clear its own address and drop its own rows):

```sql
UPDATE session SET runtime = NULL, address = NULL
WHERE agent = 'coordinator' AND runtime = :runtime AND address = :to
RETURNING project_id;                                   -- each: dropWaiting(project_id)

UPDATE session SET address = :to
WHERE agent = 'coordinator' AND runtime = :runtime AND address = :from;
```

#### Coordinator session report flow

Some harnesses learn their own conversation id only after they start: Claude and Codex report it from the turn-end
(Stop) hook, Pi from the extension after the first turn. So `harness_session_id` on a coordinator row is written twice:

1. **Launch** (`omac launch <harness> [--new]`, before `execve`): `Project.CoordinatorSession { harness, fresh,
   paneId }` → `coordinatorLaunch` (above): the project's coordinator row keeps its id, takes the new location and
   harness, and keeps `harness_session_id` only for the same harness without `--new`. Returns
   `{ sessionId, harnessSessionId }`. `omac launch` sets `OMAC_SESSION_ID=<sessionId>`, `OMAC_AGENT=coordinator` and
   execs the harness, resuming `harnessSessionId` if set.
2. **Report** (each turn end; Pi after its first turn): the hook or extension reads `OMAC_SESSION_ID` and sends
   `CoordinatorSessionReady { sessionId, harness, harnessSessionId }`. With `OMAC_LAUNCH_ID` / `OMAC_LAUNCH_PID` gone
   the hook compares nothing locally (no process walk): it sends unconditionally and omacd decides. Fire-and-forget: a
   failed report only means the next launch resumes the older conversation.
3. **Apply** (`reportCoordinatorSession`), one statement:

   ```sql
   UPDATE session SET harness_session_id = ?
   WHERE id = ? AND agent = 'coordinator' AND harness_id = ?
   ```

   The last report wins. Two live processes of one harness (an earlier launch still running, or two reports arriving
   out of order) may overwrite each other's conversation id; the next launch then resumes one of them — accepted, as
   with the harnesses themselves, which do not restrict two instances of one session either.

   | Reporter                                                                                                                     | Outcome                                                                                                                                                                                                                                                                                                                                                                                            |
   | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | the launched harness                                                                                                         | applied                                                                                                                                                                                                                                                                                                                                                                                            |
   | an earlier launch of the same harness still running (the user answered `N` at launch, or it was not a terminal)              | applied too; last report wins (above)                                                                                                                                                                                                                                                                                                                                                              |
   | an earlier launch of another harness still running (or its late report)                                                      | `harness_id` is no longer the row's                                                                                                                                                                                                                                                                                                                                                                |
   | an earlier launch stopped at launch (`y`)                                                                                    | none after it exits, and `omac launch` execs only once it has; a report it sent before that is overwritten by the new harness's, or ignored after a harness switch                                                                                                                                                                                                                                 |
   | a harness CLI (`claude`, `codex`, `pi`, `cursor-agent`) run from the coordinator's shell; it would inherit `OMAC_SESSION_ID` | does not happen: the coordinator guard denies these programs by name, also behind wrappers, `sh -c` and `$(…)` (`guard.ts` `HARNESS_CLIS`, `shellBlock`; Pi runs the same rules in process, `pi-omac/src/extension.ts`). A harness started some other way (a script, a variable) is not recognized. Holds where the guard runs: Claude / Codex / Cursor with `omac integration install`, Pi always |
   | a Claude subagent (Task tool) of a Claude coordinator                                                                        | not a report: subagents fire `SubagentStop`, not `Stop` (Claude Code hooks docs, code.claude.com/docs/en/hooks), and omac hooks only `Stop` / `StopFailure` (`integration.ts:49`)                                                                                                                                                                                                                  |
   | a Pi child of a Pi coordinator in print / RPC mode                                                                           | not a report: the extension reports only in TUI mode (`pi-omac/src/extension.ts:85`; `Inbox.Subscribe` likewise, `:119`)                                                                                                                                                                                                                                                                           |
   | a non-coordinator session (its own `OMAC_SESSION_ID`)                                                                        | `agent` does not match; its id is recorded by `check` / `collectResult` instead                                                                                                                                                                                                                                                                                                                    |

   0 rows changed is not an error to the reporter (it is a hook; nothing to show); omacd logs it at debug.

   Not covered (exists today, unchanged here): a nested `claude -p` inside a `general` session inherits
   `OMAC_SESSION_ID` / `OMAC_AGENT=general` (the session guard does not refuse other programs), so its turn-end hook
   can write that session's result file and send `ResultReady`; `workerResult` guards only Codex / Cursor (by thread
   id). Not part of this design.

Queries for non-coordinator sessions (`agent != 'coordinator'`):

| Path                                                                      | Query                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSession` (`managed()`, `check`, `deliver`, `resume`, `remove`, `Get`) | `WHERE id = ? AND agent != 'coordinator'`; `managed()` allows a coordinator when `project_id = c.projectId`, the command line always                      |
| `listSessions` (`List`)                                                   | coordinator: `agent != 'coordinator' AND project_id = ?` (`session_project`); cli: `agent != 'coordinator'`; `stopped = false` adds `status != 'stopped'` |
| recovery / poll / `workspace_closed`                                      | `agent != 'coordinator' AND status != 'stopped'`, then by `address`                                                                                       |
| limit check (`insertSession`)                                             | `count(*) WHERE agent != 'coordinator' AND status != 'stopped'`, same transaction as the insert                                                           |

Delivery to a project (`Inbox.deliver`): `coordinatorOf(project)` = `agent = 'coordinator' AND project_id = ?` (one
row, `session_coordinator`); its `address` is where the batch goes. **No backlog**: a report, result or notice row is
only ever delivered to a coordinator that is there to take it.

Presence is judged by the row's place: `coordinatorIdle(address)` asks the runtime what that place runs, from the
runtime alone (no state in omacd, so an omacd restart changes no answer). No process id is looked up and the coordinator is not searched for
in other panes; moves and closes come from herdr's `pane_moved` / `pane_closed` events (`moveCoordinator`,
`clearCoordinator`).

| `coordinatorIdle(address)` | Meaning                                                                                                    | Rows                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `idle`                     | a harness runs there and is idle                                                                           | prompt harness: claimed and prompted (below). Pi: left `pending` for its subscribers, which claim them (below) |
| `busy`                     | a harness runs there and is working, or something other than the shell is in the pane's foreground (below) | wait for the next idle event                                                                                   |
| `unknown`                  | the runtime could not answer (unreachable, `HerdrError`, no shell or foreground group reported)            | wait; recheck on the next event or reconcile tick                                                              |
| `gone`                     | the pane is missing, or its shell is in the foreground                                                     | `dropped`                                                                                                      |

herdr, in order:

1. `agent.get` on the pane reports an agent → `idle` / `busy` from its status.
2. No agent: `pane.process_info` on the pane. It returns `shell_pid` and `foreground_process_group_id`
   (`src/api/schema/panes.rs:544-554`; filled in `src/app/api/panes.rs:526-571`). `shell_pid` is the pid of the
   process herdr spawned on the pane's PTY, stored when it spawns it (`src/pane.rs:2744`, read by `child_pid()`,
   `:3842`). `foreground_process_group_id` is that terminal's foreground process group, read from the shell's process
   (`e_tpgid`, `src/platform/macos.rs:522-547`; `tpgid` from `/proc/<pid>/stat`, `src/platform/linux.rs:653-661`).
   - group ≠ `shell_pid` → `busy`: a foreground job runs — `omac launch` before its `execve`, or the harness before herdr
     recognises it (the startup window), or a harness herdr never recognises.
   - group = `shell_pid` → `gone`: an interactive shell leads its own process group, so the shell is waiting at its
     prompt and nothing runs.
   - `pane_not_found` (`panes.rs:531-539`) → `gone`.
   - `shell_pid` or the group absent, or any other error → `unknown`.

This covers the startup window without state: between `coordinatorLaunch` and herdr recognising the harness, the
pane's foreground is `omac launch` and then the harness, never the shell. It relies on `omac launch` running from the
pane's shell (its own job, as a shell child) rather than being the pane's process itself; `omac launch` and the tab
`Launch` opens both do that. A harness that never leaves the foreground keeps rows waiting until it exits or the pane
closes; that is the same as a busy harness.

| When a row is ready, or a waiting row is rechecked | Outcome                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| no coordinator row, or no address                  | `dropped` at once — decided in the insert itself (below) |
| `coordinatorIdle` → `idle` / `busy` / `unknown`    | as above                                                 |
| `coordinatorIdle` → `gone`                         | `dropped`                                                |

Waiting rows are dropped the same way, by `dropWaiting(project)`, when their coordinator disappears:
`clearCoordinator` (pane closed), a `gone` answer on an idle event or reconcile tick, and `coordinatorLaunch` (a new
launch is a new consumer; it never sees what was waiting for the previous one). A Pi stream closing drops nothing: the
next check of the place decides. Nothing is decided by elapsed time.

```sql
UPDATE inbox SET status = 'dropped'
WHERE status = 'pending' AND kind != 'send'
  AND session_id IN (SELECT id FROM session WHERE project_id = :project AND agent != 'coordinator')
  AND EXISTS (SELECT 1 FROM session WHERE project_id = :project AND agent = 'coordinator'      -- only after a
              AND runtime = :runtime AND address = :address)                              -- runtime answer
```

**Guard by the coordinator that was read.** A delivery fibre reads the coordinator (`runtime`, `address`), then
awaits the runtime (`coordinatorIdle`). Meanwhile another project can launch into that pane and
this project can relaunch elsewhere; without a guard the fibre would prompt rows into another project's coordinator, or
a stale `gone` would drop rows meant for the new coordinator. So every claim and every drop that follows a runtime
answer carries `AND EXISTS (SELECT 1 FROM session WHERE project_id = :project AND agent = 'coordinator'
AND runtime = :runtime AND address = :address)` with the values the fibre read — the `gone` drop above and the claim
below. If the coordinator changed, the statement changes nothing and the next event
starts over. `coordinatorLaunch`, `moveCoordinator` and `clearCoordinator` change the coordinator and drop in one
transaction, with no await in between, so their `dropWaiting` carries no guard (the `EXISTS` line is left out).

**At insert.** "No coordinator, or no address" needs no runtime answer, so it is decided when the row is written
(Report / finish / notice):

```sql
INSERT INTO inbox (session_id, kind, message, details, status, created_at)
VALUES (:session, :kind, :message, :details,
  CASE WHEN EXISTS (SELECT 1 FROM session WHERE project_id = :project AND agent = 'coordinator'
                    AND address IS NOT NULL) THEN 'pending' ELSE 'dropped' END,
  :now)
```

A dropped row is never delivered, including after the next `omac launch`. It stays in the table (rows are kept
forever), so `omac result <id>` still shows a session's latest result. This holds for every session of the project, including those
started from a plain terminal.

**Claiming.** Every inbox status change is guarded on the status it expects, and only claimed rows are delivered —
the same for coordinator-bound and session-bound rows (coordinator-bound rows now use `sending` too):

```sql
UPDATE inbox SET status = 'sending'   WHERE id IN (:batch)   AND status = 'pending'               -- claim
  AND EXISTS (SELECT 1 FROM session WHERE project_id = :project AND agent = 'coordinator'
              AND runtime = :runtime AND address = :address)               -- coordinator-bound rows only
RETURNING id;
-- prompt / push exactly the returned ids
UPDATE inbox SET status = 'delivered' WHERE id IN (:claimed) AND status = 'sending';
UPDATE inbox SET status = 'failed'    WHERE id IN (:claimed) AND status = 'sending';               -- runtime error
```

`dropWaiting` changes only `pending` rows and delivery prompts only ids it claimed from `pending`; statements are
serialised, so each row is either claimed or dropped, never both. Precisely: a row that is `dropped` is never claimed,
so never delivered; a row claimed before a drop is delivered to the coordinator that was present when it was claimed,
and the claim's guard makes that the coordinator the fibre read.

A Pi subscriber claims with the same statement, guarded by the coordinator row as its connection read it; with two
live Pi coordinators of one repository, whichever subscriber claims a batch first takes it — accepted.

The prompt / push after a claim runs under `Effect.onExit`: any exit other than success (runtime error, timeout,
interruption, shutdown) sets the claimed rows `sending` → `failed`, so a fibre that stops after its claim does not
leave rows in `sending` until the next restart.

**Startup recovery** (omacd start, before any delivery): coordinator-bound rows left in `sending` were handed to a
coordinator that may or may not have received them → `UPDATE inbox SET status = 'failed' WHERE status = 'sending' AND
kind != 'send'`. Session-bound rows left in `sending`: as today, `check` reports them to the coordinator as possibly
undelivered (`undelivered`, `workers.ts` ~501-503).

`dropped` rather than reusing `failed`: `failed` already means a delivery was attempted and the runtime errored
(`inbox.ts`, `HerdrError`); `dropped` means no attempt was made because nobody was there. Keeping them apart keeps
the two cases readable in the database and in `omac result`'s output.

Dropped versus today: the `worker` table (its columns are the non-coordinator columns), `worker.herdr_session` (→
`runtime` / `address`), `caller_id` (→ `project_id`; the ownership split is gone), `session.kind` (→ `agent`), `session.launch_id` (gone: the stable session id and the harness match replace it),
`session.seen_at` (nothing needs it with one coordinator row), `session.created_at`.

### 1.3 `inbox` — messages between a session and its coordinator

Every row concerns exactly one non-coordinator session: Send (to the session, from its coordinator or the command
line), Report and result (session → its project's coordinator), notice (omacd → the coordinator, about one session). So a row has a real FK to its session, and direction and sender follow from
`kind`:

| `kind`   | From → to                             | Today                                                   |
| -------- | ------------------------------------- | ------------------------------------------------------- |
| `send`   | coordinator or command line → session | `message` with `sender_id = owner`                      |
| `report` | session → coordinator                 | `message` from `omac report`                            |
| `result` | session → coordinator                 | `result`                                                |
| `notice` | omacd → coordinator                   | `notice` with `sender_id = 'omacd'`, `details.workerId` |

SQLite cannot check the referenced row's agent, so the three insert paths (Send, Report / finish, notice) are the
guarantee that rows never reference a coordinator session (application code, each path covered by a test; no trigger). The receiver is never stored: it is the coordinator of the
session's `project_id`, so it cannot go stale. This removes the polymorphic `sender_id` / `receiver_id` strings and the
`workerId` copy in `details`. Accepted consequence: `send` rows do not record who sent them, so a user's `omac send`
and the coordinator's messages to the same session can merge into one delivery (one turn); both speak for the
coordinator side.

| Query                                                                                                          | Shape                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| session's queue (`pendingInbox(session)`, `inboxWithStatus`)                                                   | `session_id = ? AND kind = 'send' AND status = ?` (`inbox_session`, all three columns)                                                                                                                                                                             |
| coordinator's queue (`coordinatorPending(project)`)                                                            | `inbox JOIN session ON session.id = inbox.session_id WHERE session.project_id = ? AND inbox.kind != 'send' AND inbox.status = 'pending' ORDER BY inbox.id` — only rows waiting for a present coordinator (no backlog: rows with nobody to take them are `dropped`) |
| drop waiting rows (`dropWaiting(project)`)                                                                     | see Delivery (§1.2) (`session_project`, then `inbox_waiting`)                                                                                                                                                                                                      |
| projects with rows waiting (reconcile tick: deliver if idle, `dropWaiting` if gone, nothing if busy / unknown) | same join, `DISTINCT session.project_id`                                                                                                                                                                                                                           |
| latest result (`Get`, `omac result`)                                                                           | `session_id = ? AND kind = 'result' ORDER BY id DESC LIMIT 1` (any status, `dropped` included)                                                                                                                                                                     |

**Kept forever.** omac never deletes a session or inbox row. Today omacd purges once a day (`daemon.ts` ~42-50,
`db.ts` ~258-271): stopped Workers idle over 14 days (`RETENTION`) with their inbox rows, every inbox row older than
that, and then any result or rules file whose id has no row. All of it goes in PR 2: `purge` and its daily schedule,
`RETENTION`, `Db.purge`, `Db.workerIds` (its only other user, `plugins.test.ts workerCount`, counts `listSessions`
instead) and the purge test in `unit.test.ts` (~128). Only `omac rm` deletes files (§1.4), and only that session's own
result and rules files.

No sweep is needed for files: a file's id has a row forever, and `omac rm` run again deletes what an earlier
interrupted run left. Files stay only where they belong to a kept row: a session removed with `--keep-worktree` or
whose processes are not confirmed gone keeps its two small files, as today. Files of sessions from the old database
have no row; the PR 2 release note moves `results/` and `rules/` away with `omac.db`.

If `omac.db` ever grows too large, a user-run `omac prune` can be added then; not now.

Query plans (`EXPLAIN QUERY PLAN`, SQLite 3 on the schema above):

```
pendingInbox(session):   SEARCH inbox USING INDEX inbox_session (session_id=? AND kind=? AND status=?)
coordinatorPending:      SEARCH session USING INDEX session_project (project_id=?)
                         SEARCH inbox USING INDEX inbox_waiting (session_id=?)
                         USE TEMP B-TREE FOR ORDER BY            (a batch's few rows)
reconcile (projects):    SCAN inbox USING INDEX inbox_waiting    (only waiting rows)
                         SEARCH session USING INDEX sqlite_autoindex_session_1 (id=?)
                         USE TEMP B-TREE FOR DISTINCT
dropWaiting(project):    LIST SUBQUERY: SEARCH session USING INDEX session_project (project_id=?)
                         SEARCH inbox USING COVERING INDEX inbox_session (session_id=?)
```

`nextBatch` merges consecutive rows of one sender: `kind = 'notice'` → omacd, otherwise the session. `latestInbox` loses
its unused `afterId` parameter, and with it the reason for `AUTOINCREMENT`: a plain rowid orders rows as needed.

### 1.4 `omac rm` — a soft delete

`omac rm` removes a session from work, not from omac. What it does stays as today (SPEC §8.6a, §8.7, `remove.ts`):

1. stops the harness: interrupt (`--stop`), then close the pane omac opened for the session (herdr ends what runs in
   it, up to SIGKILL), and its workspace when nothing else is open in it;
2. removes the worktree with git (`git worktree remove`, never forced) only when nothing would be lost and the
   processes are confirmed gone; the branch is always kept;
3. marks the session removed: `metadata.removed` at once (no send, delivery or resume brings it back), and `status =
   'stopped'` once its processes are confirmed gone; deletes its result and rules files when the worktree is removed
   (or already gone) and its processes are confirmed gone.

The row, its inbox rows and its results stay (§1.3 "Kept forever"): `omac ls --all` lists the session, `omac result
<id>` shows its latest result. Today a stopped row is purged after 14 days, so this promise holds only once purge is
gone; the wording below ships with it in PR 2.

Result JSON (after PR 1's `runtime` → `processes`), unchanged otherwise:

```
{ id, processes: "exited" | "alive" | "unknown", pane: "closed" | "kept" | "none",
  workspace: "closed" | "kept" | "none", worktree: "removed" | "kept" | "gone", path, branch, reasons }
```

`reasons` says what was kept and why, e.g. `worktree kept: its processes are not confirmed gone`, `worktree kept: git
would delete ignored files that are not omac's copies: …`, `worktree kept: git refused: …`, `workspace <id> kept:
something else is still open in it`, `<path> was already gone`. None of them is about the row: the row is always kept.

Wording, PR 2:

- CLI help (`cli.ts` `rm`): "Remove a session from work (soft delete): close its pane (herdr ends what runs in it, up
  to SIGKILL) and its workspace when nothing else is open in it; once those processes are confirmed gone (`processes:
  exited`) and no process works in the worktree, remove the worktree with git when nothing would be lost (no changes,
  no untracked or ignored files of anyone's, HEAD on a branch). The branch is always kept. The session is marked
  removed and can no longer be sent to or resumed; its record, messages and results stay (`omac ls --all`, `omac
  result <id>`). `reasons` says what was kept and why. Safe to run again: `processes: alive` or `unknown` keeps the
  worktree, and a later run checks again." `--keep-worktree`: "Remove the session but keep its worktree".
- Coordinator rules (`rules.ts`): "**`${o} rm <id> [--keep-worktree] [--stop]`** - Remove an idle session from work
  (`--stop` ends a working one the user wants gone): its pane closes, its branch is kept, and git removes its worktree
  only when nothing would be lost. Nothing is deleted from omac: the session stays in `${o} ls --all` and `${o} result
  <id>`, but can no longer be sent to. The JSON says what was kept and why; run it again once that is resolved". The
  clean-up line (`rules.ts` ~127) keeps its meaning: "Never remove a session, its pane or its worktree any other way."
- SPEC §8.6a opens with: "`omac rm` is a soft delete: it stops the session's harness, closes the pane and workspace
  omac opened for it, removes its worktree only when git would lose nothing (the branch is always kept), and marks the
  session removed. The row, its inbox and its results are never deleted (§5.5): `omac ls --all` and `omac result
  <id>` still show them." Step 8 lists the result with `processes`; the closing paragraph drops "and is not deleted by
  retention cleanup". §8.7: the result and rules files are the only things `omac rm` deletes.

## 2. RPC (`rpc.ts`, `server.ts`, `cli.ts`, `client.ts`)

Hello, HelloRequired, and connection annotations were removed. The live contract is request headers: `omac-protocol` (constant `PROTOCOL` in `protocol.ts`, not the package version) on every method except Ping, and `omac-caller` plus session id or repository on scoped methods. Project and agent come from the stored session. A missing caller is not cli. Ping reports protocol and an informational package version; a package-only difference does not restart omacd. See spec.md §7.

**Connection owner** becomes a tagged value, not a string:
`{ _tag: "Coordinator", projectId, sessionId } | { _tag: "Cli" } | { _tag: "Session", sessionId }`.

**Caller** is resolved per request from headers, not stored on the socket. `omac-caller: cli` requires `omac-repository` and is rejected if `omac-session-id` is also present. `omac-caller: session` requires `omac-session-id`; the server reads that row and decides the side from `agent` (a session never declares itself coordinator). Missing, mixed, or malformed headers are `InvalidCaller` and never become cli. An unknown session id is `NoSuchSession` (`no session <id>`).

- coordinator row → `Coordinator` of its project. `omac-repository`, when present, is the working directory for checkout, not identity. An earlier launch's process carries the same id and keeps its identity; it is just not at the row's address, so it is not prompted.
- any other session → `Session`, Report only. A repository header on that request is rejected.
- the command line is `cli` only when it sends `omac-caller: cli`. A shell in a herdr pane is `cli` too: a pane no longer claims anything.

`cli.ts caller`: `OMAC_SESSION_ID` set → session headers, and the process is an agent (never starts omacd, may not run `omac daemon` / `omac launch`); unset → cli headers for the working directory. The Pi extension reads `OMAC_AGENT` (§6) to pick its mode; as coordinator its `Inbox.Subscribe` sends session headers for that `sessionId`, plus `omac-protocol`. `herdr` is a payload on `Spawn`, `Launch`, `Project.CoordinatorSession`, and `Project.RunningCoordinator`, not a connection field.

Codex: the coordinator's shell commands need `OMAC_SESSION_ID` (and the guard `OMAC_AGENT`). Claude's Bash already
inherits them from the exec env; Codex hands its shell only the variables listed in `shell_environment_policy.set`, so
`Launch.entryCommand` puts both in the env passed to `coordinatorArgs`. This reverses 7759f49 (the launch id kept
out of the shell policy; `launch.ts:84`): the assertion in `test/unit.test.ts` (~406-410) that Codex args do not contain
the launch token is inverted. The id then shows in the Codex process's argv (`ps`); acceptable, since identities are
self-declared by same-user processes, not authentication (SPEC §13).

| Method                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project.CoordinatorSession`            | payload `{ harness, fresh, paneId, herdr? }`: `cli.ts launch` passes the pane it execs in (`here.paneId`) and the caller's herdr location. `coordinatorLaunch` updates (or first creates) the row. Returns `{ sessionId, harnessSessionId }`: `OMAC_SESSION_ID` for the env, the conversation to reopen                                                                                                                                                                                                                                                                                            |
| `Project.RunningCoordinator` (new)      | payload `{ paneId, herdr? }`; coordinator-launch only (`cli.ts launch`, before `Project.CoordinatorSession`). Returns `{ harness, place, address } \| null` (§1.2 "A coordinator still running"): `place` display text, `address` opaque, passed back to stop                                                                                                                                                                                                                                                                                                                                      |
| `Project.StopCoordinator` (new)         | payload `{ runtime, address }`; returns `{ result: "stopped" \| "running" \| "moved" \| "unsupported", reason? }`. `moved` when the project's coordinator row is no longer at `address`; otherwise `stopAgent`: SIGTERM to the recorded harness PID only, its terminal kept, `stopped` once it exited (at most 10 s), else `running` with nothing changed                                                                                                                                                                                                                                          |
| `CoordinatorSessionReady`               | payload `{ sessionId, harness, harnessSessionId }` (`reportedAt` and the launch id go; `sessionId` is now `OMAC_SESSION_ID`; today's `sessionId` field, the harness's id, becomes `harnessSessionId`). Applied as in §1.2 "Coordinator session report flow"                                                                                                                                                                                                                                                                                                                                        |
| `Spawn`                                 | coordinator: session of agent `general` in its project; refused (`Forbidden`) when the repository header's key is not that project's (a coordinator that `cd`'d into another repository). cli: in `projectId(key of root)`, stored like any other session (omacd runs it: state, inbox, cleanup). `runtime/address` from the `herdr` payload, resolved per request. `peer?` shares that session's worktree. Room for agents: a later `agent?` field (`omac run --agent <name>`), default `general`; `coordinator` rejected (`Forbidden`), `general` allowed (it may be customized, never replaced) |
| `managed()` (Send / Interrupt / Remove) | cli: any non-coordinator session. coordinator: any non-coordinator session with `project_id = c.projectId`, whoever started it                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `List`                                  | payload `{ stopped?: boolean }`, filtered in SQL. coordinator: every session of its project; cli: all. `cli.ts` passes `--all` as `stopped` (today it sends `all: !agent` and filters client-side, ignoring `--all` for agents)                                                                                                                                                                                                                                                                                                                                                                    |
| `Report`                                | inserts `kind = 'report'` for the session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Send`                                  | inserts `kind = 'send'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Inbox.Subscribe`                       | no payload; coordinator only (TUI Pi). Streams batches it claims (§Delivery) while the row's harness is `pi`; with two live Pi coordinators of one repository, whichever subscriber claims a batch first takes it — accepted. A stream closing drops nothing                                                                                                                                                                                                                                                                                                                                       |
| `Get`                                   | `result` = latest `result` row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Launch`                                | returns `{ place, attach }` instead of `{ paneId, herdrSession }`: `place` is display text and `attach` the argv to attach to it (or null), both from the runtime module, so `cli.ts` (~187-191: the printed pane, `herdr session attach`) no longer decodes herdr. The command it types into the new shell carries the hidden `--in-parent <root>` flag (§6.3)                                                                                                                                                                                                                                    |
| `ResultReady`                           | payload `{ workerId }` → `{ sessionId }` (`rpc.ts:152`, the turn-end hook `integration.ts:144`, the Pi extension `extension.ts:60`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Project.*`                             | coordinator: scoped by its session's project (from `OMAC_SESSION_ID`), the same rule as `Spawn`, not by a connection working directory; cli: by the `omac-repository` header                                                                                                                                                                                                                                                                                                                                                                                                                       |

Wire shapes: `WorkerInfo` → `SessionInfo`, with `agent`, `projectId`, `runtime`, `address` instead
of `callerId` / `herdrSession` / `herdrName`. `InboxMessage` becomes `{ id, sessionId, kind, message, details, status,
createdAt }`. `VERSION` bumps.

Scratch (PR 2): `layout.scratch(key)` = `projects/<key>/scratch` — the owner level was only there because owners were
panes. `<key>` can contain `/` (a normalized remote such as `github.com/owner/repo`, `worktree.ts` ~47-55).

## 3. Runtime boundary

What omac asks of a runtime today, by caller:

| Operation                   | herdr calls today                                                                                                                     | Callers                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| resolve a client's location | `herdr session list`, `herdr server --session`                                                                                        | `HerdrPool.resolve` (Spawn, Launch, `Project.CoordinatorSession`, `Project.RunningCoordinator`) |
| create a session's place    | `worktree.create`, `tab.create{env}`, `pane.close` root                                                                               | spawn (`launch`)                                                                                |
| reopen it                   | `worktree.open`, `tab.create{env}`, `pane.close`                                                                                      | `resume`                                                                                        |
| start the harness           | `agent.start{name,kind,pane,args}` (+ retry on `agent_pane_busy`)                                                                     | `startAgent`                                                                                    |
| harness state               | `agent.get(s-<id>)`: status, `state_change_seq`, `agent_session`, `interactive_ready`, pane                                           | `check`, `prompt`, `confirmed`, `deliver`, `remove`                                             |
| send text / keys            | `agent.prompt`, `agent.send_keys`, `pane.send_keys` (startup dialogs)                                                                 | `prompt`, `interruptAgent`, `awaitReady`                                                        |
| wait                        | `agent.wait{until,timeout}`                                                                                                           | `interruptAgent`                                                                                |
| read                        | `pane.read recent_unwrapped`                                                                                                          | `paneTail`                                                                                      |
| close with proof            | `pane.list`, `workspace.list`, `pane.process_info`, `pane.close`                                                                      | `Remove.release` pane/workspace steps                                                           |
| coordinator delivery        | `agent.get(pane)` (idle / gone?), `agent.prompt(pane)`; new: `pane.process_info` when no agent (§1.2)                                 | `Inbox.toPane`                                                                                  |
| stop a coordinator (new)    | signal 0 and SIGTERM to the recorded harness PID (local machine only); `agent.get` sees the agent first                               | `Project.StopCoordinator`                                                                       |
| coordinator launch          | `worktree.list`, `pane.get`, `tab.create`/`workspace.create`, `pane.wait_for_output`, `pane.send_text`, `pane.send_keys`, `tab.close` | `launch.ts`, `cli.ts launch`                                                                    |
| events                      | `pane.updated`, `pane.closed`, `pane.moved`, `workspace.closed`                                                                       | `Session.onEvent`, `Inbox` trigger                                                              |

(herdr calls a running harness an "agent"; that word stays inside `runtime/herdr.ts`.)

Boundary: one module, `packages/cli/src/runtime/herdr.ts`, providing a `HerdrRuntime` service whose methods take a
session row or a decoded address and speak omac terms:

```ts
spawnPlace(s, { root, worktree, label, env }) / reopenPlace(s, …)  → void
startHarness(s, args, resume)                                     → void
harness(s)            → Option<{ status, seq, harnessSessionId, ready, place }>   // place: opaque, for tails / proof
prompt(s, text) · keys(s, keys) · waitIdle(s, timeout) · tail(s, lines)
release(s, { harnessAtStart })  → { pane, workspace, processes, records } // Remove's runtime half, owns metadata.stop
coordinatorIdle(addr) → "idle" | "busy" | "gone" | "unknown"  ·  promptCoordinator(addr, text)
stopAgent(addr)       → stopped | running | moved | unsupported(reason)  // SIGTERM to the harness PID only; never the group or the pane
launchCoordinator({ root, argv, focus }) → address
events: Stream<{ _tag: "SessionChanged", sessionId } | { _tag: "CoordinatorIdle", projectId }
              | { _tag: "CoordinatorMoved", from, to } | { _tag: "CoordinatorClosed", address }
              | { _tag: "PlaceClosed", place }>
```

`stopAgent`: see **A coordinator still running** above.

The adapter maps events to omac ids (pane → session via its in-memory last-seen pane; pane → project via
`db.coordinatorAt`), so `sessions.ts` and `inbox.ts` stop parsing panes: `pane_updated` idle → `coordinatorAt` →
deliver to that project; `pane_moved` → `moveCoordinator` (address only) plus the session pane remap; `pane_closed` of a
coordinator pane → `clearCoordinator`. `renameOwner` and `paneOwner` are deleted. This mapping ships in PR 2 (inline,
since PR 2 deletes `paneOwner` / `renameOwner`); PR 3 only moves it into the adapter.

Moves: `herdr-pool.ts` → `runtime/herdr-pool.ts` unchanged; from `sessions.ts` `agentInfo`, `agentGet`, `awaitReady`,
`paneTail`, `startAgent`, `confirmed`'s probe, `interruptAgent`, the herdr half of `launch` / `resume`, `onEvent`; from
`inbox.ts` `toPane` and the `pane_updated` trigger; from `remove.ts` `ownWorkspace`, `closable`, `closePane` (the
git/worktree half stays); `launch.ts` herdr helpers whole. Generic: the session state machine, turn logic, inbox rows
and locks, git/worktree removal, caller headers and ownership.

Not built: a runtime registry, plugin point, or `Runtime` interface with one implementation. `runtime` only ever holds
`"herdr"`; a second runtime extracts the interface from `HerdrRuntime`'s methods.

## 4. Renames of the conflicting "runtime" (PR 1)

| Now                                                                                                                               | Where                                                      | New                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RemoveOutcome.runtime: "exited" \| "alive" \| "unknown"` (JSON of `omac rm`)                                                     | `remove.ts`, `rpc.ts`, `cli.ts` rm description, SPEC §8.6a | `processes`                                                                                                                                                                                                  |
| `type Runtime = RemoveOutcome["runtime"]`, `confirmRuntime`, reason "its runtime is not confirmed gone"                           | `remove.ts`                                                | `ProcessState`, `confirmExited`, "its processes are not confirmed gone"                                                                                                                                      |
| `interface Runtime`, `newRuntime`, `runtimes`, `rt(id)` (per-session lock, last pane, timers)                                     | `workers.ts`                                               | `Tracked`, `newTracked`, `tracked`, `track(id)`                                                                                                                                                              |
| `Daemon.Runtime` (sqlite driver, socket server, processes, plugin loader from `#platform`), `Platform.runtime`, `daemon(runtime)` | `daemon.ts`, `platform/*.ts`, `main.ts`, `cli.ts`          | `Daemon.Host`, `Platform.daemon`, `daemon(host)` (not `Platform` / `services`: `Platform.services` already exists in `platform/bun.ts`, `main.ts` imports `* as Platform`, `workers.ts` has `type Platform`) |
| `PluginRuntime`                                                                                                                   | `plugin-sources.ts`, `plugins.ts`, `platform/*.ts`         | `PluginLoader`                                                                                                                                                                                               |

The JS runtime (Bun / Node) keeps being called by name; only omac identifiers change.

Also in PR 1, the omacd state file is renamed, nothing else:

| Now                  | Where                                                           | New                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omac/omacd.json` | `paths.ts` (`Paths.daemonInfo`, which keeps its name), SPEC §14 | `~/.omac/omacd.pid`; content unchanged (the same `DaemonInfo` JSON: `pid`, `version`, `socket`, `startedAt`), writer and readers unchanged apart from the path |

## 5. Vocabulary renames (PR 1)

User-visible, all in PR 1:

| Now                                                                                                                                                                                                                                                                                                                                                                                                                         | New                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| env `OMAC_WORKER_ID`, `OMAC_COORDINATOR`, `OMAC_LAUNCH_ID`, `OMAC_LAUNCH_PID`, `OMAC_SCRATCH`, `OMAC_IN_PARENT_WORKSPACE`, `OMAC_HERDR_SESSION`, `OMAC_MAX_WORKERS`                                                                                                                                                                                                                                                         | §6                                                                                                                                                                                                                                                                                                |
| guard "role": `omac integration guard <role>` with `coordinator \| worker`, `OMAC_ROLE` in the hook script, `Guard.worker`, "the role's rules"                                                                                                                                                                                                                                                                              | the guard reads `OMAC_AGENT` itself: `omac integration guard` takes no role; `Guard.coordinator` for `coordinator`, `Guard.session` for every other agent; `Guard.Rules` per agent. Hook scripts change, so the integration version bumps and `omac integration install` rewrites them            |
| error tags `NoSuchWorker`, `WorkerBusy`; message "no Worker <id>"                                                                                                                                                                                                                                                                                                                                                           | `NoSuchSession`, `SessionBusy`; "no session <id>"                                                                                                                                                                                                                                                 |
| CLI help: "Worker id", "Continue a Worker", "Interrupt a Worker's running turn", "Close the Worker…", "Stopped Workers too", "Your Workers…", "Worker only: send a progress report… to the Coordinator that gave you your task", "lessons injected into every Worker", the top-level description "coordinates Workers running in herdr panes"                                                                               | "session id", "Continue a session", "Interrupt a session's running turn", "Close the session…", "Stopped sessions too", "Your sessions…", "Sessions only: send a progress report… to the coordinator that gave you your task", "every session", "a coordinator directing sessions in herdr panes" |
| session rules (`rules.ts workerRules`, header comment "Worker rules") "# You are Worker {id}, working for a Coordinator agent", "Worker id" in the scratch filename rule                                                                                                                                                                                                                                                    | "# You are session {id}, working for the coordinator", "your session id" (`workerRules` → `sessionRules`)                                                                                                                                                                                         |
| Casing: "Coordinator" / "Coordinators" / "Worker" capitalized in prose — SPEC, `rules.ts` (both prompts: "You are a Coordinator", "working for a Coordinator agent"), CLI help ("the Coordinator that gave you your task"), error and notice messages (`managed()` "belongs to another Coordinator", guard denials "Workers only run omac report; … the Coordinator's or the user's", `cli.ts caller`), README / plugins.md | lowercase common nouns per the glossary: "You are the coordinator", "belongs to another coordinator", "sessions only run omac report; … the coordinator's or the user's"; identifiers unchanged                                                                                                   |
| herdr agent name `w-<id>` (notices: `herdr agent focus w-<id>`)                                                                                                                                                                                                                                                                                                                                                             | `s-<id>` — in PR 2, with the schema reset, so no running session is renamed under an old database                                                                                                                                                                                                 |
| SPEC: "Worker" throughout (§4, §5, §7, §8 "Worker Lifecycle", §11.4 "Worker as Receiver", §12.2 roles)                                                                                                                                                                                                                                                                                                                      | "session"; §12.2 "Roles" → "Agents" (coordinator and the rest)                                                                                                                                                                                                                                    |

Coordinator prompt (`coordinatorRules`), smallest consistent wording: "# You are the coordinator. You direct coding
sessions; they do the work." and "Start a session (an interactive coding agent in its own pane and git worktree)" for
`spawn`; "agent" stays only where it means the definition, which today is nowhere else. When user-defined agents exist,
`--agent <name>` gets one line.

Envelopes: `<agent-result …>` and `<agent-message …>` keep their names — a session reports as the agent it runs — and
gain `agent="general"`; `id` is the session id. Nothing that reads them changes.

Internal names (`workers.ts` / `Workers` service, `WorkerRow`, `WorkerView`, `WorkerInfo`, `getWorker`, …) are renamed
to `sessions.ts` / `Session`, `SessionRow`, `SessionView`, `SessionInfo`, `getSession` in PR 2, which rewrites them
anyway.

## 6. Environment variables (PR 1, identity values in PR 2)

### 6.1 herdr as the reference

herdr (`/tmp/github.com/herdrdev/herdr` at `287da807`) sets in every pane it starts (`src/pane.rs` 198-219, after the
launch env's extras, so its own values win; `src/integration/env.rs` 28-33):

| herdr variable                                        | Value                                                                                           | Read by                                                                                                                      | Purpose                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `HERDR_ENV`                                           | `1`                                                                                             | `herdr` itself (`main.rs` `should_block_nested`), every integration hook (`[ "$HERDR_ENV" = 1 ] \|\| exit 0`)                | "inside herdr": refuse a nested herdr, gate hooks |
| `HERDR_SOCKET_PATH`                                   | the server's API socket                                                                         | the `herdr` CLI (picks that server, and with it the session: `--session` > `HERDR_SOCKET_PATH` > `HERDR_SESSION`), hooks     | which server to talk to                           |
| `HERDR_BIN_PATH`                                      | the herdr executable                                                                            | hooks, plugins                                                                                                               | how to call back into this herdr build            |
| `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | the pane's place (`HERDR_PANE_ID` removed when a pane is launched without identity, `OmitPane`) | the `herdr` CLI (`cli/target.rs caller_pane_id`: default target), hooks (`herdr pane report-agent-session $HERDR_PANE_ID …`) | **who am I**: the pane                            |

It reads, besides those: `HERDR_SESSION` (named session when not inside a server), `HERDR_CONFIG_PATH`, `HERDR_HOME`,
`HERDR_LOG`, and `HERDR_AGENT` — a hint in a _process's_ environment naming which agent CLI it is (`platform/mod.rs`
`parse_agent_env_hint`, for wrappers that hide the binary name). Plugins get `HERDR_PLUGIN_*` context. Some hooks pass
data to their own `python3` through `HERDR_HOOK_INPUT_FILE`.

Identity and nesting in herdr: a process is identified by its pane (`HERDR_PANE_ID`), because herdr _is_ the runtime —
its identity is the place. Nesting is handled two ways: `HERDR_ENV=1` refuses a herdr inside herdr; agent reports carry a
monotonic `--seq` (`time.time_ns()`), and the newest report for a pane wins — herdr does not tell a nested harness from
the pane's own.

### 6.2 What omac needs, given herdr's

Could a session be identified from `HERDR_PANE_ID` + omacd's state alone? No:

- Identity must survive relocation and be runtime-neutral (§0). A pane id is a location: it changes on a move (omacd
  learns it from an event, after the fact), is reused, and does not exist outside herdr (a Pi coordinator outside a
  pane, a future runtime).
- The guard decides on every tool call, locally, before the call runs, and must not depend on reaching omacd (a Codex
  coordinator's sandbox may block the socket, SPEC §13 / Codex notes). It needs "coordinator or not" from the
  environment.
- A coordinator's session report must name the coordinator's harness; omac keys it on the session id and harness, and
  keeps nested harness processes out by the coordinator guard (§1.2 report flow), not by pane.

So omac keeps its own identity variable, modelled on herdr's split: one id for "who am I" (`HERDR_PANE_ID` ↔
`OMAC_SESSION_ID`), one name for "what am I" (`HERDR_AGENT` ↔ `OMAC_AGENT`, though herdr's names the harness and omac's
the agent), one way back to the same build (`HERDR_BIN_PATH` ↔ `OMAC_COMMAND`), one home. The presence of
`OMAC_SESSION_ID` plays `HERDR_ENV`'s part ("inside omac": no nested omacd or `omac launch`). omac's location comes from
herdr's own variables (`HERDR_PANE_ID`, `HERDR_SOCKET_PATH`), which omac only reads; omac never copies them into
variables of its own.

| omac variable     | Value per agent                                                                                                                                 | Why it is not derivable                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMAC_SESSION_ID` | `coordinator`: the project's coordinator session id (stable across relaunches and harness switches); `general` / user-defined: the session's id | the caller's identity on scoped requests; survives pane moves and other runtimes                                                                               |
| `OMAC_AGENT`      | `coordinator` \| `general` \| (later) the user-defined name                                                                                     | the guard's rule set, the Pi extension's mode, the turn-end hook's branch (coordinator report vs result file), all local without omacd                         |
| `OMAC_HOME`       | as configured                                                                                                                                   | panes inherit the herdr server's environment, not the user's shell or omacd's: without it a session's `omac` would look for another omacd                      |
| `OMAC_COMMAND`    | JSON argv of this omac build                                                                                                                    | a checkout runs `bun …/main.ts`, not `omac` on PATH; keeps sessions on omacd's build (`VersionMismatch` otherwise) — herdr does the same with `HERDR_BIN_PATH` |

Alternative to `OMAC_AGENT` considered and rejected: the guard opens `omac.db` read-only and looks the id up. It would
tie a hook that runs on every tool call to the database schema and file; the agent name is one more self-declared
variable under the same trust model as the id.

What replaces the pid suffix: nothing. A report is accepted by session id, `agent = 'coordinator'` and harness; the last
report wins; harness CLIs are kept out of the coordinator's shell by its guard (§1.2 report flow).

### 6.3 Inventory and result

| Name                                              | Set by                            | Read by                                                                             | Why                                                           | After                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMAC_WORKER_ID`                                  | omac, session tabs                | `cli.ts caller` / `client.ts` Hello, guard hook script, turn-end hook, Pi extension | a session's identity                                          | `OMAC_SESSION_ID`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OMAC_COORDINATOR` (`=1`)                         | `launch.ts`                       | `cli.ts caller`, guard hook script, turn-end hook, Pi extension                     | "this is a coordinator"                                       | `OMAC_AGENT=coordinator`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `OMAC_LAUNCH_ID`                                  | `launch.ts` exec env              | turn-end hook, Pi extension (`CoordinatorSessionReady`)                             | which launch a report belongs to                              | gone: the stable coordinator session id                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OMAC_LAUNCH_PID`                                 | `platform/bun.ts exec`            | turn-end hook, Pi extension                                                         | only the exec'd harness reports                               | gone: last report wins; the coordinator guard keeps nested harnesses out                                                                                                                                                                                                                                                                                                                                                                           |
| `OMAC_ROLE`, `OMAC_HOOK_INPUT_FILE`               | hook scripts, for their `python3` | that `python3`                                                                      | script-local plumbing                                         | gone: passed as arguments (`python3 - <agent> <file>`)                                                                                                                                                                                                                                                                                                                                                                                             |
| `OMAC_SCRATCH`                                    | omac, session tabs                | guard                                                                               | the one project directory a session may touch                 | kept in PR 1; gone in PR 2, together with the move to per-project scratch: the guard then allows `<OMAC_HOME>/projects/**/scratch/**` from the path alone (`**` because the key can contain `/`). Ceiling: a session may write another project's scratch; the guard stops mistakes, not attackers (SPEC §13)                                                                                                                                       |
| `OMAC_IN_PARENT_WORKSPACE`                        | `Launch` RPC, the tab it opens    | `cli.ts launch` there                                                               | skip asking herdr whether the pane is in the parent workspace | replaced by a hidden flag on the command `Launch` types into the new shell: `omac launch --in-parent <root> …`. The signal must stay by construction: herdr does not report a just-created workspace as the parent, so asking it would make the re-run `omac launch` call `Launch` again, without end (fixed in 7411b13). A flag, unlike the variable, applies to that one command only and is not inherited by everything later run in that shell |
| `OMAC_HERDR_SESSION`                              | user                              | `client.ts` Hello                                                                   | herdr session outside herdr                                   | gone: runtime-specific; `--session` stays as the runtime option, default `omac` (herdr's own `HERDR_SESSION` stays herdr's)                                                                                                                                                                                                                                                                                                                        |
| `OMAC_HOME`                                       | user; omac passes it on           | everything                                                                          | where omac's state lives                                      | kept                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OMAC_COMMAND`                                    | omac                              | Pi extension, guard, hook scripts, rules                                            | this build's argv                                             | kept                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OMAC_MAX_WORKERS`                                | user                              | `Workers.layer`                                                                     | cap on running sessions                                       | `OMAC_MAX_SESSIONS`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `OMAC_PROJECT_ID`                                 | user                              | `repositoryKey`                                                                     | override the repository key                                   | kept                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OMAC_PI_PACKAGE`                                 | user (dev)                        | `main.ts` → Pi integration                                                          | local `@omac/pi`                                              | kept                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OMAC_BUILD_FLAGS`                                | `bun build --define`              | `build-flags.ts`                                                                    | compile-time constant                                         | unchanged; not an environment variable                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OMAC_INTEGRATION_ID`, `OMAC_INTEGRATION_VERSION` | `omac integration install`        | `integration.ts`                                                                    | marker lines in managed files                                 | unchanged; not environment variables                                                                                                                                                                                                                                                                                                                                                                                                               |

Result. omac sets in every session it starts: `OMAC_SESSION_ID`, `OMAC_AGENT`, `OMAC_HOME`, `OMAC_COMMAND` (plus the
user's `--env`; Codex coordinators also get `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` passed through, as today). omac reads
as configuration: `OMAC_HOME`, `OMAC_MAX_SESSIONS`, `OMAC_PROJECT_ID`, `OMAC_PI_PACKAGE`. SPEC §14 lists exactly these.

PR 1 ships the names with today's values; PR 2 changes the values. Interim state in PR 1:

- `OMAC_SESSION_ID` is the Worker id for a session, and the launch id for a coordinator. The coordinator's value stays
  out of Codex's shell policy (7759f49) until PR 2, where it becomes the session id; only `OMAC_AGENT` joins the policy
  in PR 1 (it replaces `OMAC_COORDINATOR`, which is in it today).
- `cli.ts caller` branches on `OMAC_AGENT`: `coordinator` → Hello as a coordinator by `HERDR_PANE_ID`, as today;
  any other value → Hello as a session by `OMAC_SESSION_ID` (today's `workerId`); unset → `Cli`.
- `OMAC_LAUNCH_PID` and its check, `OMAC_SCRATCH` and the scratch layout stay until PR 2; `--in-parent` replaces
  `OMAC_IN_PARENT_WORKSPACE` in PR 1.

## 7. Rollout (PRs to `main`, in order)

1. **Renames and environment**: the conflicting `runtime` identifiers and `omacd.json` → `omacd.pid` (§4), the vocabulary and casing (§5), the
   environment names (§6) in omac, the Pi extension and the hook scripts. Breaking for running sessions (they carry the
   old variables): release note says to let them finish, relaunch coordinators and reinstall integrations (`omac
   integration install all`). `omac rm` JSON key `runtime` → `processes`. `OMAC_IN_PARENT_WORKSPACE` → hidden `--in-parent`.
2. **Schema and identity** (breaking, one PR because every table changes together): the §1 schema and
   `SchemaMismatch` (surfaced by `startDaemon`), `Db` rewritten (`projectId`, `insertSession`, `coordinatorLaunch`
   (upsert of the project's one row), `reportCoordinatorSession` (id + harness), `coordinatorOf`,
   `coordinatorAt`, `moveCoordinator`, `clearCoordinator`, `coordinatorPending`; `renameOwner` gone), internal `Worker*` →
   `Session*` names, herdr name `s-<id>`, tagged connection owner, per-request caller headers (no Hello),
   `Project.CoordinatorSession { paneId }`, `CoordinatorSessionReady { sessionId, harnessSessionId }`,
   `Inbox.Subscribe` with claiming, delivery to the coordinator row, herdr event mapping (`pane_updated` → `coordinatorAt`, `pane_moved` → `moveCoordinator`,
   `pane_closed` → `clearCoordinator`), `OMAC_SESSION_ID` / `OMAC_AGENT` in Codex's shell policy (unit test inverted),
   `OMAC_LAUNCH_PID` removed, `Spawn` / `managed()` / `List { stopped }` / `Report` / `Send` / `Inbox` on the new shapes,
   `SessionInfo` / `InboxMessage` / `Launch` result, `ResultReady { sessionId }`, scratch per project with
   `OMAC_SCRATCH` removed and the guard's `projects/**/scratch/**` rule, `coordinatorIdle(address)`, `Project.RunningCoordinator` / `Project.StopCoordinator` with `stopAgent` and the
   `omac launch` warning and `[y/N]` prompt, Pi extension protocol headers, `VERSION` bump; no retention (§1.3 "Kept forever":
   `purge`, its daily schedule, `RETENTION`, `Db.purge`, `Db.workerIds` and the orphan sweep deleted, foreign keys
   without `ON DELETE CASCADE`); `omac rm` described as a soft delete (§1.4) in its CLI help, the coordinator rules
   and SPEC §8.6a / §8.7; SPEC §4,
   §5.1 (`scratch/<owner>/` in the layout and the ownership table), §5.2, §5.5 (remove / cleanup without "next
   retention cleanup", "Retention Cleanup" removed, result history kept forever), §7, §11, §12.2 (coordinator by
   session id, not `HERDR_PANE_ID`), §14 (no startup purge, no `RETENTION`).
   Release note: stop omacd and move `~/.omac/omac.db` (and `~/.omac/results/`, `~/.omac/rules/`) away before starting
   the new one; sessions from the old database
   are no longer known to omac (their worktrees and herdr panes stay for the user). Every running coordinator must be
   relaunched with `omac launch` (its id is unknown to the new database, so its `omac` calls get `NoSuchSession`).
   Behaviour change: sessions started from a terminal (`omac run`) are no longer the user's alone. The repository's
   coordinator lists them, can send to, interrupt and remove them, and receives their reports, results and notices
   (`omac result` still works for them).
   Behaviour change: no backlog for the coordinator. A report, result or notice produced while no coordinator is there
   to take it (none launched, pane closed, its process exited) is marked `dropped` and never delivered,
   not even after the next `omac launch`; `omac result <id>` still shows it. Rows wait only for a coordinator whose
   process is still there (busy, starting, or not answerable right now).
   Behaviour change: session data is never deleted. Sessions and their inbox rows are kept forever, including after
   `omac rm` (a soft delete: `omac ls --all`, `omac result <id>`); there is no 14-day purge.
3. **Runtime boundary**: move herdr code into `runtime/herdr.ts` / `runtime/herdr-pool.ts` (§3); pure move plus event
   mapping, no behavior change.

Later, not designed here: user-defined agents (`omac run --agent <name>`, loading their definitions). Fixed now: the
reserved names `coordinator` and `general` (Glossary); a definition with a reserved name customizes the built-in.
