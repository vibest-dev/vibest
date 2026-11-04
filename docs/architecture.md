# vibest architecture (branch refactor/engine)

This describes the code on this branch as it is. Where the code does not yet reach the target (an engine that names
no product notion), the gap is listed under "Known limits" with the reason. The older design notes in docs/design/
describe earlier states and are not kept in step with this file.

## Layers and the import graph

vibest is an agent engine with a product on it, hosted by one daemon (vibestd) and driven by thin clients.

- **Contracts.** `@vibest/schema` (shared types and the on-disk layout), `@vibest/plugin` (the plugin API: agent
  definitions, hooks, session actions, the harness adapter and runtime contracts), `@vibest/protocol` (the RPC
  between clients and vibestd).
- **Engine.** `@vibest/core`: sessions, inbox, reply routing, delivery, turn tracking, events and storage, the guard,
  capabilities of agent definitions, the harness adapters claude, pi and cursor, and the plugin host.
- **Product.** `@vibest/vibest`: the workspace (git checkouts and the detached worktrees sessions work in), terminal
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
`@vibest/vibest`, and does not list it as a dependency; core's sources contain none of the product notions moved out
in this round (the worktrees root and leaf names, `instructions.md`, the session system prompt text), and its
placement, removal, system prompt and workspace modules name no entry agent; and the engine-only product test
imports nothing but core, the contracts and effect. `apps/vibest/test/boundaries.test.ts` keeps herdr out of every
runtime-neutral package but the host.

## Engine ports (filled by a product)

Core defines these services; `@vibest/vibest` provides the vibest implementations, and
`apps/vibest/test/engine-only.test.ts` provides a second, minimal set.

- **Workspace** (`core/workspace.ts`). Where a session works. `project(directory)` gives the grouping root and key;
  `repositories`, `mainCheckout`, `state`, `repositoryStates` read it; `reserve(root)` names and makes a new
  session's directory (failing with `WorkspaceRefused`); `prepare(root, path, shared)` makes it ready for the
  harness inside a scope and undoes that when the scope closes failed; `release({ id, path, keep, processes,
  liveSharers })` decides, once the engine has closed the terminal and proven which processes still work there,
  whether the directory goes, and returns `removed`, `kept` or `gone`, why, whether a live sharer kept it, and its
  branch; `files(key)` makes the directory a group's sessions share working files in and gives the variables that
  name it in their shell (vibest: the project's scratch directory, VIBEST_SCRATCH). vibest's implementation (`vibest/workspace.ts`) uses detached git worktrees under the worktrees root,
  one per repository for a multi-repository project, and removes one only when no live session shares it and git
  would lose nothing.
- **SessionPrompt** (`core/system-prompt.ts`). `text(input)` gives a session's system prompt text from its id,
  vibest command, grouping key, peer and agent definition. The engine writes it to
  `$TMPDIR/vibest/<session id>/system-prompt.md` on every harness start (new, resume, restart, move) and removes the
  directory when the session is archived; an unusable temporary directory fails the start with
  `SystemPromptDirUnsafe`. vibest's text (`vibest/system-prompt.ts`) adds the project's instructions and memory.
- **PlacementPolicy** (`core/placement.ts`). `near(session, kind)` (the terminal a new one opens beside),
  `root(session, cwd)` and `labelRoot(session, cwd)` (the directory a session's terminals belong to),
  `project(projectId, root)` (the project labels shown on a terminal) and `alone(projectId, kind, live)` (the
  terminal that shows the project when no session is labelled). vibest's policy (`vibest/placement.ts`) opens a
  session beside the lead that started it, else beside the project's main agent.
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

A session row (`session` table) is created by `Sessions.spawn`: plugins choose harness and runtime, the workspace
reserves its directory, and the row is inserted with its first prompt. `placement.ts` prepares the workspace, writes
the system prompt, and opens the session's terminal running the adapter's argv. A session's process starts and ends
as `process.start` / `process.end` events; archiving closes its terminal and releases its workspace
(`core/remove.ts`).

Every message to a session is an inbox row (`inbox` table) with a kind: `task` (its first prompt, while a polling
integration has not taken it), `send`, `report`, `result` and `notice`, and a status: `pending`, `delivering`,
`delivered`, `failed`, `dropped`. A row with no recipient is the user's (`vibest inbox`).

A turn's state on the session is `none`, `open`, `completed`, `failed`, `interrupted`, `lost` or `not_started`. A turn
opens when what was delivered starts it (the integration's `turn.start`, or the runtime's state for an adapter that
does not report state) and ends on the integration's `turn.end` or the runtime showing the harness idle; the rows it
consumed are bound to it (`inbox.status` events naming the turn). Turn starts and ends are `turn.start` / `turn.end`
events.

## Reply routing

`replyTo` in `core/db.ts` decides where a finished turn's result goes, then `agent.result` may rewrite it:

1. the sessions whose `task` or `send` rows the turn consumed;
2. else the session's report-to (set at spawn), or, with none, the project's entry session;
3. else the user, when the turn consumed the user's own task or send;
4. else nobody: a turn typed in the pane, or woken by a result or notice, answers no one, so a result never starts a
   result.

A recipient that has ended is replaced by the project's entry session (never the session itself), else the user.

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

One SQLite file (`~/.vibest/vibest.db`, schema version 2, `core/db.ts` `SCHEMA`): tables `project`, `session`,
`inbox`, `event`. `event` is append-only (a trigger refuses updates): processes, turns, inbox status changes and
results are events. JSON on a row is written once; state that changes has its own column; environment variables
given with `--env` are never stored; leases, restarting marks and groups are kept in memory. vibest never migrates
the file by itself.

## Engine mechanism and product policy

Mechanism in core: the delivery state machine, reply routing, turn tracking and reconciliation, the guard's checks,
the capability model of agent definitions, the settled-archive check, the system prompt file, the plugin host and the
storage. Policy outside core: which harness and runtime a start gets (plugin-harness-choice, the runtime plugin),
the coordinator and worker definitions and archive on completion (plugin-coordinator), where a session works and
when its directory may go (vibest's workspace), where its terminal opens and what its project shows (vibest's
placement policy), and its system prompt text (vibest's SessionPrompt).

## Known limits

- **The engine still names the project and the entry agent.** The `project` table, `session.project_id` and
  `project.entry_session_id` are in the engine's schema, so core's queries group by project, reply routing falls back
  to the entry session, `core/inbox.ts` delivers the entry session's rows on its own path, `core/restart.ts` restarts
  main agents, and the user inbox is per project. Replacing them with an opaque grouping is a database shape change;
  it is proposed to the owner and not implemented.
- **The guard's wording and the inspect rule set.** `core/guard.ts` names its `inspect` rule set `coordinator` and its
  refusal texts speak of the coordinator, the project directory and the scratchpad (harness-visible texts that E2E
  checks read). `LaunchInput.scratch` in the harness contract keeps its name (it carries the workspace's `files`
  directory).
- **Caller identity lives in the server.** The capability rule (who may manage a session: `mayManage` in
  `core/capabilities.ts`, from the manager's `can.message`, provenance and groups) is the engine's; mapping a request
  to a manager (the command line is the user, the entry agent owns its project, a session is itself) and the other
  method rights are in `packages/server/src/server.ts`. The engine-only test maps its plugin's actions itself.
- **Groups are in memory.** A restart of vibestd forgets them; a plugin joins its members again.
