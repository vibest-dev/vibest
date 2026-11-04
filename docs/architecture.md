# vibest architecture (branch refactor/engine)

This describes the code on this branch as it is. Where the code does not yet reach the target (an engine that names
no product notion), the gap is listed under "Known limits" with the reason. The older design notes in docs/design/
describe earlier states and are not kept in step with this file.

## Layers and the import graph

vibest is an agent engine with a product on it, hosted by one daemon (vibestd) and driven by thin clients.

- **Contracts.** `@vibest/schema` (shared types and the on-disk layout), `@vibest/plugin` (the plugin API: agent
  definitions, hooks, session actions, the harness adapter and runtime contracts), `@vibest/protocol` (the RPC
  between clients and vibestd).
- **Engine.** `@vibest/core`: sessions, inbox, reply routing, delivery, turn tracking, the `Storage` port with its read
  model, an in-memory backend and the conformance suite every backend passes, the guard, capabilities of agent definitions,
  the harness adapters claude, pi and cursor, and the plugin host. Core holds no SQL and no database schema.
- **Product.** `@vibest/vibest`: the SQLite backend of `Storage` (`sqlite-storage.ts`: the schema, its checks, the SQL, and the
  project rows a scope maps to, read through its `ProjectStore` service), the workspace (git checkouts and the detached worktrees sessions work in), terminal
  placement policy, the system prompt text and the project files it reads, project lookup, and the main agent's
  start (`launch.ts`).
- **Default plugins.** `@vibest/plugin-coordinator` (the coordinator and worker definitions, archive on completion),
  `@vibest/plugin-harness-choice` (which harness a start gets), `@vibest/runtime-herdr` (the herdr terminal runtime).
- **Daemon.** `@vibest/server`: the RPC handlers, the HTTP endpoint integrations talk to, caller identity and rights,
  and the daemon's lifecycle; `packages/server/src/platform` is the Bun host. `@vibest/server/entry` is the one
  module the command line imports from it.
- **Clients.** `@vibest/client` (connects to vibestd) and the command line `apps/vibest`.

Who imports whom (package.json dependencies, `@vibest/` packages only):

| package                                   | imports                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| schema                                    | none                                                                                                     |
| plugin                                    | none                                                                                                     |
| protocol                                  | plugin, schema                                                                                           |
| client                                    | protocol, schema                                                                                         |
| core                                      | plugin, protocol, schema                                                                                 |
| vibest                                    | core, protocol, schema                                                                                   |
| plugin-coordinator, plugin-harness-choice | plugin                                                                                                   |
| runtime-herdr                             | core, plugin, schema                                                                                     |
| server                                    | client, core, plugin, plugin-coordinator, plugin-harness-choice, protocol, runtime-herdr, schema, vibest |
| apps/vibest (sources)                     | client, protocol, schema, `@vibest/server/entry`, `#platform` (the host)                                 |

`apps/vibest/test/layering.test.ts` enforces: the command line's sources import only the client, the contracts,
effect, the server entry and `#platform`; core runs no git, imports no worktree or project code and nothing of
`@vibest/vibest`, and does not list it as a dependency; core imports nothing whose name contains `sql`, uses no
`SqlClient`, and its package.json names no SQL package, while the schema lives in vibest's backend; core's sources
contain none of the product notions moved out (the worktrees root and leaf names, `instructions.md`, the session
system prompt text, VIBEST_SCRATCH and the projects directory); its storage port, memory backend, read model and inbox name
no project id or coordinator operation; its placement, removal, system prompt and workspace modules name no entry
agent; and the engine-only product test imports nothing but core, the contracts and effect. `apps/vibest/test/boundaries.test.ts` keeps herdr out of every
runtime-neutral package but the host.

## Engine ports (filled by a product)

Core defines these services; `@vibest/vibest` provides the vibest implementations, and
`apps/vibest/test/engine-only.test.ts` provides a second, minimal set.

- **Storage** (`core/storage.ts` `StorageShape`; see "Storage model" for its contracts). Operations on sessions,
  owners, processes, turns and inbox rows, never table access. vibest's backend is SQLite; core's own is
  `core/memory-storage.ts`.

- **Workspace** (`core/workspace.ts`). Where a session works. `project(directory)` gives the grouping root and key;
  `repositories`, `mainCheckout`, `state`, `repositoryStates` read it; `reserve(root)` names and makes a new
  session's directory (failing with `WorkspaceRefused`); `prepare(root, path, shared)` makes it ready for the
  harness inside a scope and undoes that when the scope closes failed; `release({ id, path, keep, processes,
  liveSharers })` decides, once the engine has closed the terminal and proven which processes still work there,
  whether the directory goes, and returns `removed`, `kept` or `gone`, why, whether a live sharer kept it, and its
  branch; `files(key)` makes the directory a scope's sessions share working files in and gives the product's
  variables for that scope in their shell (vibest: the project's scratch directory as VIBEST_SCRATCH, and the
  project's id as VIBEST_PROJECT_ID, which its integrations send back to name the project). vibest's implementation (`vibest/workspace.ts`) uses detached git worktrees under the worktrees root,
  one per repository for a multi-repository project, and removes one only when no live session shares it and git
  would lose nothing.
- **SessionPrompt** (`core/system-prompt.ts`). `text(input)` gives a session's system prompt text from its id,
  vibest command, grouping key, peer and agent definition. The engine writes it to
  `$TMPDIR/vibest/<session id>/system-prompt.md` on every harness start (new, resume, restart, move) and removes the
  directory when the session is archived; an unusable temporary directory fails the start with
  `SystemPromptDirUnsafe`. vibest's text (`vibest/system-prompt.ts`) adds the project's instructions and memory.
- **PlacementPolicy** (`core/placement.ts`). `near(session, kind)` (the terminal a new one opens beside),
  `root(session, cwd)` and `labelRoot(session, cwd)` (the directory a session's terminals belong to),
  `labels(scope, root)` (the scope's labels shown on a terminal) and `alone(scope, kind, live)` (the terminal that
  shows the scope when no session is labelled). vibest's policy (`vibest/placement.ts`) opens a session beside the
  lead that started it, else beside the scope's owner (its main agent), and labels the project's name and how many
  of its sessions are live.
- **Runtime** (`@vibest/plugin` `Runtime`). A terminal runtime: `open`, `send`, `close`, `state`, `present` and the
  rest in `packages/plugin/src/runtime.ts`; registered by a plugin and routed by `runtime.kind`.
- **HarnessAdapter** (`packages/plugin/src/harness.ts`). What differs between agent CLIs; claude, pi and cursor are
  built in (`core/harnesses/`), a plugin registers more with `context.harness.register`. Core reads the fields and
  never branches on a harness id.
- **Processes** (`core/processes.ts`): liveness, SIGTERM to one pid, and the processes whose cwd is in a directory.
- **GuardArea** (`core/guard.ts`): what the `full` tier keeps a session out of: a home, a protected directory under
  it, and the one place in it the session may use. vibestd gives vibest's (VIBEST_HOME, the projects directory, the
  session's project's scratch directory) for each `/guard` call (`packages/server/src/http.ts`).

## Plugin API

A plugin (`Plugin.define({ id, effect })`) gets a context with:

- `context.agent.define(definition)`: an agent definition with `name`, `tools` (`inspect` or `full`, the guard's
  tier), `can.spawn`, `can.message` (`report-only`, `children`, `group`, `project`), `rules`, `entry` and `skills`.
- `context.agent.hook(name, callback)` for the hooks below.
- `context.session` (`SessionActions`): `send`, `spawn`, `archive` and `notice`, each acting as one session (`as`)
  and checked as that session's own command would be (`archive` and `notice` also as the user). The product installs
  the implementations (`Actions.install`): vibest's server checks them with its RPC rights, which use the engine's
  `mayManage`.
- `context.group` (`SessionGroups`): `join`, `leave`, `members`; groups live in vibestd's memory (`core/groups.ts`).
- `context.harness.register(adapter)` and `context.runtime` (the runtime registry).

Hooks (`packages/plugin/src/index.ts` `Hooks`), run one after another in plugin order:

- `agent.start.before`: before any agent starts; plugins may set the prompt, harness, provider, model, machine and
  runtime; a callback may refuse with `AgentRefused`. The engine validates harness and runtime after the chain.
- `agent.fail`: a round failed on a usage limit; `move` restarts the same session on another harness or provider.
- `agent.result`: a turn ended with a result; `recipients` is the routed list and may be rewritten (forward, fan out,
  or empty: the result is then the session's own, stored as `dropped`).
- `agent.notice`: vibest tells someone about a session (`blocked`, `not_started`, `undelivered`, `archived`,
  `message`); text and recipients may be rewritten.
- `agent.delivered`: a session's result was delivered (with its `archiveOnCompletion` flag). plugin-coordinator
  archives the session from here; core keeps only `archiveSettled`, which archives once the session has settled.

## Session, inbox and turn lifecycle

A session is created by `Sessions.spawn` in a scope (the grouping the product gives it; vibest: the project's key):
plugins choose harness and runtime, the workspace reserves its directory, and `Storage` inserts it with its first
prompt (`insertSession`). `placement.ts` prepares the workspace, writes
the system prompt, and opens the session's terminal running the adapter's argv. A session's process starts and ends
as `process.start` / `process.end` events; archiving closes its terminal and releases its workspace
(`core/remove.ts`).

Every message to a session is an inbox row with a kind: `task` (its first prompt, while a polling
integration has not taken it), `send`, `report`, `result` and `notice`, and a status: `pending`, `delivering`,
`delivered`, `failed`, `dropped`. A row with no recipient is the
user's (`vibest inbox`). A scope may have one owner, a session the product starts with `startOwner` (vibest: the
project's main agent): rows with no other session to go to go to it, `core/inbox.ts` delivers them (typed when it is
idle, or leased to a polling integration), and they drop while it has no place.

A turn's state on the session is `none`, `open`, `completed`, `failed`, `interrupted`, `lost` or `not_started`. A turn
opens when what was delivered starts it (the integration's `turn.start`, or the runtime's state for an adapter that
does not report state) and ends on the integration's `turn.end` or the runtime showing the harness idle; the rows it
consumed are bound to it (`inbox.status` events naming the turn). Turn starts and ends are `turn.start` / `turn.end`
events.

## Reply routing

`Storage.replyTo` (contract in `core/storage.ts`, the same in both backends) decides where a finished turn's result goes,
then `agent.result` may rewrite it:

1. the sessions whose `task` or `send` rows the turn consumed;
2. else the session's report-to (set at spawn: `--report-to`, its parent, else the scope's owner);
3. else the user, when the turn consumed the user's own task or send;
4. else nobody: a turn typed in the pane, or woken by a result or notice, answers no one, so a result never starts a
   result.

A recipient that has ended is replaced by the scope's owner (never the session itself), else the user.

## Delivery per harness

| harness | conversation id       | system prompt                | delivery                                   | subagents | reports state      | skills                                                            |
| ------- | --------------------- | ---------------------------- | ------------------------------------------ | --------- | ------------------ | ----------------------------------------------------------------- |
| claude  | assigned by vibest    | flag (file)                  | poll (the plugin takes its rows over HTTP) | typed     | yes                | per-session plugin directory holding only its definition's skills |
| pi      | assigned by vibest    | flag (file)                  | poll (the extension)                       | poll      | yes                | the extension reads VIBEST_SKILLS                                 |
| cursor  | reported by its hooks | in front of the first prompt | typed                                      | typed     | no (runtime state) | none                                                              |

Typed delivery sends the rows' text to the terminal through the runtime; polled delivery leases a batch to the
integration (`/inbox/poll`), which acks what it took (`/inbox/ack`). A poll answers empty while the session's lock is held
(its launch holds it).

## Storage model

Storage is a port. `core/storage.ts` defines the `Storage` service (`StorageShape`): the operations the engine needs, grouped by an opaque
**scope** string the engine only compares, and each scope's **owner**. What a backend keeps are facts: sessions (a
scope, parent, report-to, role, name, machine, directory, created and ended), inbox rows, and append-only events
(`process.start`, `process.ready`, `process.conversation`, `process.end`, `turn.start`, `turn.end`, `inbox.queued`,
`inbox.status`). Every row the port returns is derived from them by the shared read model (`core/read-model.ts`),
so a session's process, turn, ready and pid are what its latest events say. The contract every backend keeps:

- **Atomic operations.** Each operation sees and leaves a consistent state; two never interleave their changes
  (SQLite: one connection and transactions; memory: one lock around every operation).
- **Append-only events, ordered by id.** Nothing updates an event. One `process.end` per process (`endProcess` is
  false the second time); one `turn.end` per turn (`finishTurn`, `closeTurn` and a result row close the open turn
  once; with none open a result opens and closes one).
- **Exclusive claims.** `claim` moves pending rows to delivering and returns each id to one caller only, however many
  race; with a guard it claims only while the scope's owner is at the place the caller read. A guarded move
  (`setInboxStatus` with `from`) changes only rows still in that status, so a claim and a drop never both land.
- **Owners.** `startOwner` creates the scope's owner on first use and keeps its id across starts; the same harness
  continues its conversation unless `fresh`, which replaces the owner (the old one stays readable). Starting at a
  place takes it from another scope's owner, whose waiting rows drop. While an owner has no place (its process ended,
  `clearOwnerAt`, or it moves: `detachOwner`), rows to it are dropped, except a moving owner's, which wait.
- **Reads.** Unknown ids read as absent and write nothing; an owner whose process lives is not listed among its scope's sessions;
  `listSessions` lists live processes unless `stopped`.
- **Detached values.** Changing a row passed in or read back changes nothing stored.
- **What a backend trusts.** The engine checks what values mean (ids, harnesses, places, texts) before it calls; a
  backend checks only the rules above.
- **Failures.** A backend failure is a defect (SQLite: `orDie`); a backend retries its own transient failures, and an
  operation's error channel carries only the outcomes its type names.
- **Memory only.** The runtime status, the integration a session's requests carry until its next ready report, the
  hand-over time of an open turn and a moving owner are kept in the backend's memory; leases, restarting marks and
  groups in vibestd's. `--env` values are never stored.

`core/storage-conformance.ts` is the shared conformance suite, `storageConformance(name, layer)`, which gives every
case a fresh, empty backend; the in-memory backend (`core/memory-storage.test.ts`) and vibest's SQLite backend
(`apps/vibest/test/storage-conformance.test.ts`) both register it. What only one backend has (the SQLite file's
schema check, two processes opening one empty file) is tested beside that backend.

vibest's backend (`packages/vibest/src/sqlite-storage.ts`) is one SQLite file (`~/.vibest/vibest.db`, schema version 2,
application id `vibe`): tables `project`, `session`, `inbox`, `event`, with a trigger refusing event updates. A scope
is a project's key: the backend maps it to `session.project_id`, and the owner to `project.entry_session_id`; vibest's
own reads of its project rows (the numeric project id the command line and VIBEST_PROJECT_ID show) are its
`ProjectStore` service. The file is accepted only when its version pragmas and objects match; vibest never migrates it by
itself. JSON on a row is written once; state that changes has its own column.

### What the port took from pi-durable

pi-durable (`packages/durable` of earendil-works/pi, with the third-party backend j-koester/pi-durable-postgres and
the Durable Object example earendil-works/pi-durable-cloudflare) has the same split: one `Storage` interface in the
kernel, backends outside it, one conformance suite. Taken:

- the name: a `Storage` service in core, and backends (memory in core, SQLite in the product);
- one statement at the top of the interface of what a backend enforces (atomicity, exclusive claims, one end per
  process and turn, detached values) and what it trusts the engine for (what the values mean);
- the failure rule: a backend error is final for the caller and the backend retries its own transient failures;
  unknown ids read as absent with no effect;
- the conformance suite as a function every backend registers with a fresh backend per case
  (`registerStorageConformance` there, `storageConformance` here), with backend-only behaviour tested beside the
  backend;
- the memory backend as the reference semantics, copying what it keeps and what it returns;
- schema, versions and file checks inside the backend: pi's SQLite and Postgres backends keep their migrations and
  version table to themselves and refuse a newer schema, as vibest's backend keeps `application_id`, `user_version`
  and its object check;
- no lease or lock in the port: pi serializes commits in its Session and the Postgres backend holds one advisory lock
  per schema; vibest serializes inside each backend (vibestd and the command line both open the file) and keeps
  inbox leases in vibestd's memory.

Not taken:

- **A thin port.** pi's `Storage` is one `commit(batches of typed record writes)` plus keyed lookups and cursor scans,
  and every rule lives once in the kernel. vibest's port is about fifty engine operations (`claim`, `replyTo`,
  `startOwner`, …) whose rules each backend implements, held equal by the conformance suite. Moving to a thin port
  needs no schema change, but moves the routing, claim and owner rules into core and rewrites both backends: a
  separate step.
- **Automatic migrations.** pi applies pending migrations at open; vibest refuses a file whose schema differs and
  never migrates it by itself, because the owner approves every database shape change.
- Cursor paging, commit sequence numbers and receipts, group commit, document bases and deltas, and a JSONL backend:
  vibest's data is small, one vibestd writes it, and nothing reads history by commit.

## Engine mechanism and product policy

Mechanism in core: the delivery state machine, reply routing, turn tracking and reconciliation, the guard's checks,
the capability model of agent definitions, the settled-archive check, the system prompt file, the plugin host, the
storage port's contract and its in-memory backend. Policy outside core: which harness and runtime a start gets (plugin-harness-choice, the runtime plugin),
the coordinator and worker definitions and archive on completion (plugin-coordinator), where a session works and
when its directory may go (vibest's workspace), where its terminal opens and what its project shows (vibest's
placement policy), its system prompt text (vibest's SessionPrompt), and how sessions are kept on disk and what a
scope is (vibest's SQLite backend: a project).

## Known limits

- **Product words left in core.** The storage port, the inbox, placement, restart and the capability rule speak of
  scopes and owners, but other core names still carry vibest's words: an owner session's agent is `main` (the read
  model, `core/rounds.ts`, `core/sessions.ts` and `core/restart.ts` check it); `Layout` (`core/paths.ts`) is vibest's
  home layout; the harness contract's `LaunchInput.worktree` and `scratch`, and the claude, pi and cursor adapters'
  coordinator arguments, are harness-integration names this branch does not change; the runtime's `present` labels
  carry a `project` key (herdr's); the environment variables are VIBEST_*; and comments in `sessions.ts`, `move.ts`,
  `remove.ts` and `processes.ts` speak of worktrees and the project. None of these touches the database.
- **The guard's wording and the inspect rule set.** `core/guard.ts` names its `inspect` rule set `coordinator` and its
  refusal texts speak of the coordinator, the project directory and the scratchpad (harness-visible texts that E2E
  checks read). `LaunchInput.scratch` in the harness contract keeps its name (it carries the workspace's `files`
  directory).
- **Caller identity lives in the server.** The capability rule (who may manage a session: `mayManage` in
  `core/capabilities.ts`, from the manager's `can.message`, provenance and groups) is the engine's; mapping a request
  to a manager (the command line is the user, the entry agent owns its project, a session is itself) and the other
  method rights are in `packages/server/src/server.ts`. The engine-only test maps its plugin's actions itself.
- **Groups are in memory.** A restart of vibestd forgets them; a plugin joins its members again.
