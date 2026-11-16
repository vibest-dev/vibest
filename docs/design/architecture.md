# vibest Architecture

Status: describes what main implements.

vibest is a **product for one person**, shaped like Claude Projects or Cursor projects: a Project holds your
instructions, knowledge, memory, and conversations, and inside it you chat with one **entry session** that hands work
to the other **sessions** it starts, the CLI agents installed on your machines (Claude Code, Cursor, Pi, …), running in terminal panes
you can watch and step into (herdr first; the runtime is a port, D14). It is not a workflow framework and not a platform for composing agent engines.

The daily experience, which every part of this document serves:

1. `cd shop && vibest` opens the Project's entry session and resumes its conversation (the Project is created on
   first use); `vibest --new` starts a new conversation in the same Project, with the same knowledge.
2. You say what you want. The entry session, running the `coordinator` agent definition, decides how to split it, starts
   sessions with `vibest run`, and does not block: you keep talking while they work in panes beside it, grouped under
   the Project.
3. A session tells the session that started it what it found by running `vibest send` when it decides to; the entry session checks it and reports. An execution end sends nothing.
4. You can step into any session's pane, also after it finished, and keep talking to it.
5. The entry session always knows every session's task, status, and latest reply (`vibest ls`), also after
   compaction or a restart.
6. When a job needs a fixed flow (plan → implement → review until both sides agree → pull request), the entry
   session runs it with a skill, driving several sessions, with you able to step in at every point.

The core is a kernel: it names no orchestration role. It knows sessions, each session's parent (its creator), and each project's entry session (the one the user enters through). The behaviour above belongs to an agent definition, `coordinator`, and its prompt, which the builtin plugin `vibest.agent` delivers (§1.1).

- It is not a coding agent: it does not own conversations, tools, or models.
- **The agent runtime is a port** (D14): panes, processes, starting an agent, typing into it, reading its screen,
  machines. herdr is the first implementation, not a dependency of the core.
- **Harness adapters** are built in and hold every per-CLI difference (§8). Their integration side installs a
  vibest plugin or hook into each CLI, so every step of the CLI agent's work comes back to vibest as an event,
  and messages go into the agent natively. The rest of vibest is harness-neutral.
- vibest starts inside a Project directory. Each Project has one **entry session** the user chats with; every other
  session is started by a session with `vibest run`, which records its caller as the new session's parent.

Reference implementations:

- **OpenCode V2** (`anomalyco/opencode` at `f0944f0`, 2026-10-30): vibest borrows its code architecture, Effect
  patterns, and plugin API, and its split of **domain in the core, implementation and rules in plugins**. It
  does not borrow the coding-agent domain or the vocabulary; Appendix A maps each borrowed pattern to its source.

## 0. Fixed decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The runtime (herdr first) runs panes and processes. What happens inside a CLI agent reaches vibest first through harness integrations (hooks, plugins, extensions); the runtime's state detection and screen reading are the fallback. Per-CLI differences live only in harness adapters.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D2  | The core defines the domain (schema contracts, lifecycles, execution, scheduling framework). Implementations and rules are plugins, builtin by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | The execution unit is the **session**: one long-lived conversation with a CLI agent, handling one input at a time (an **execution**). The core defines no orchestration patterns and no roles. A flow over several sessions is a skill the session that runs it follows; there is no workflow engine or program controller. Plugins observe, refuse, transform, schedule, and enforce rules (such as "a writing session is done only when the tests pass"); they never start or steer sessions.                                                                                                                                                                                                                     |
| D4  | `vibest` runs inside a Project directory and opens that Project's entry session; there is one entry session per Project (`project.entry_session_id`), with one active conversation and earlier ones kept (`vibest --new`). There is no separate `launch` command: the entry session starts through the same path as every session, placed in the current terminal. `vibest run` is run by a session and is refused with no calling session (the hint is to open one with bare `vibest`); the new session's parent is its caller. A session sends only to its parent and to sessions it started, and the user sends to any session of the Project. Nothing is routed to the entry session by default.                |
| D5  | Plugins follow OpenCode V2: `{ id, effect }` or `{ id, setup }` with Promises.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D6  | Products are composed per host from shared packages; hosts are fully isolated (no shared daemon, database, or sessions). The Herdr TUI product comes first; the herdr-core desktop application comes after the base capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D7  | Machine and multi-repository Project dimensions exist from the first commit; one machine and one repository are special cases. Several repositories are composed by copying them into one directory, never by symlinks (Node and other toolchains break on symlinked folders).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D8  | In scope now: delegation (an entry session and the sessions it starts); the `pipeline` skill (plan → implement → review → pull request); multi-machine scheduling. Other multi-agent flows (committee, racing, advisor, …) are added later as skills, by us or by the user, without core changes. Out of scope: DynamicWorkflow and any workflow engine, work-item intake, several accounts per CLI (each CLI's own login is its one Subscription).                                                                                                                                                                                                                                                                 |
| D9  | Names are spelled out (`repository`, never `repo`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D10 | vibest keeps a **Subscription** for every supported harness on every machine, with its usage limits, and hands the current set to plugins in each session start's context. Choosing a harness, waiting, or switching is plugin scheduling. Usage limits come only from official or CLI-provided sources, so a harness that offers none keeps an empty limits list and that is fine; a Subscription is per (harness, provider, machine), provider empty for a single-login harness (Claude Code, Cursor) and set for Pi; vibest does not read a harness token or call a usage API, so a harness that offers no limits keeps an empty list (unknown, not full). Any vibest plugin may report a Subscription's limits. |
| D11 | Information comes through the best channel each CLI offers: hooks forward events and results where a CLI has them; an agent's own `vibest send` carries what it decides to say; reading the screen is last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D13 | The engine knows one kind of session, described by an agent definition (`id`, `description`, `system` prompt, optional `guard`). It names no orchestration role: `coordinator` and `general` are definitions the builtin plugin `vibest.agent` registers (`packages/builtins/src/agent.ts`), and no code in the core branches on either. How a session works and splits work is written only in its definition's prompt and in skills. Messages move only by explicit `vibest send`.                                                                                                                                                                                                                                |
| D14 | vibest is not bound to herdr. `schema`, `core`, `server`, `protocol`, `client`, the harness adapters, and the integrations never import herdr or name its types; they use the Runtime port (§10) and vibest's own types (Agent `status`, `runtime { kind, address }`). Everything herdr-specific (`effect-herdr-sdk`, `runtime-herdr`, the herdr plugin, the presenter) lives in herdr packages and the herdr product. Runtimes are plugins registering the `Runtime` API (`runtime-port.md`, `plugin/src/effect/runtime.ts`): herdr, rex and tern are builtin; another product is a new plugin, not a core change.                                                                                                 |

## 1. A multi-CLI agent engine

vibest is a kernel that runs many CLI agents (Claude Code, Pi, …) side by side, in terminals you can
watch and step into. The kernel names no orchestration role (no main, no coordinator); how agents work together is an
agent definition, its prompt and skills, delivered through plugins (§1.1). The daily experience above (one entry
session handing work to the sessions it starts) is what the `coordinator` definition and the `delegate` skill do.

**What the kernel knows.** A session's creator link decides who it may send to and who manages it.

- **One kind of session**, described by an **agent definition**: `{ id, description, system, guard? }`, registered by
  plugins with `ctx.agent.transform`. The definition is a prompt and a guard, never permissions: a send is allowed
  to the creator and to sessions the sender started, and management belongs to the nearest living creator.
- **An inbox per session**: every message is a row for one session, from a session or the user. One delivery path,
  locked per recipient, for the entry session and every other: through the harness integration when it can take
  input, typed into the terminal otherwise. A row with no session to go to is dropped.
- **Delivery is by recipient.** `vibest send <id>` from the user reaches any unfinished session of the same project, the entry session included. A session reaches only the session that started it, and sessions it started; when its creator has ended, a message goes to the nearest session above it that is still running, on this machine or another. An execution end writes only `execution.ended`, which carries the reply
  text, read as `execution.reply` with `vibest result`. vibest's own notices say only what an agent could
  not say itself, and go to its nearest living creator (its parent, else the parent's parent and so on; a creator on another machine through the
  outbox; none left, only the user reads it): its harness exited, its execution ended in an error, it never started, it waits on a permission. An
  undeliverable message goes back to its sender. Completed and interrupted executions send nothing, and nothing says an
  agent went idle.

- **Provenance by parent.** `parent_session_id` records who spawned whom. It is the creator link: a session
  may send only to its creator and to sessions it started, notices and sends to an ended creator go to the nearest
  living one above it, management belongs to the nearest living creator, and a new terminal opens beside the live creator.
- **An entry session per project** (`project.entry_session_id`): the session a
  bare `vibest` reopens. It is not identity; it is the one session the user enters through. A project has at most one entry session at a time; moving it to another terminal asks for confirmation.
- **Harnesses registered by plugins**: a plugin adds a `HarnessDefinition` with
  `context.harness.transform((editor) => editor.add(definition))`, like a runtime with `context.runtime.transform`.
  The two builtin harnesses are the plugins `harness-pi` and `harness-claude` in
  `packages/plugin-harnesses`, loaded first (Cursor is the same kind of plugin, built to `harnesses/cursor/index.js`
  and added by the user); their integration files stay in `packages/integration/*`. A harness id is
  a plain string: a harness the database names but no plugin provides is unavailable ("no plugin provides harness
  X; loaded: …"), never a decode failure.
- **Harness integrations** reach vibestd over its sockets, each its own way (Claude over HTTP, Pi and Cursor over RPC
  `ExecutionEnd` and `Prompt`), and the harness adapter decodes the raw event in vibestd (§8).

### 1.1 Orchestration

Coordinator behaviour is not in the core. It is the `coordinator` agent definition, its prompt and its guard, which the
builtin plugin `vibest.agent` (`packages/builtins/src/agent.ts`) registers beside a `general` definition. The
`delegate` and `pipeline` skills (`packages/skills/`) and the builtin plugin `archive-on-idle` complete it. Bare
`vibest` starts the entry session with the definition named `coordinator`; `vibest run --agent <id>` picks another. A
session's replies are read by the user; what it knows of other sessions comes from messages they chose to send, from
`vibest ls` and `vibest result`, and from notices.

Messages move only by explicit `vibest send`. An execution end sends nothing and no result is routed anywhere; a
session that has something to say runs `vibest send`. vibest's own notices go to the nearest living creator and say only
what a session could not say itself: it exited, never started, ended an execution in error, or waits on a permission.

Other arrangements are definitions, skills and plugins on the same kernel:

| Arrangement        | Built from                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegation         | the `coordinator` definition and the `delegate` skill: the entry session starts sessions, each sends to its creator when it decides to               |
| Pipeline           | the `pipeline` skill: the session that runs it starts a planner, an implementer and a reviewer, and carries messages between them with `send`        |
| Fan-out and gather | a parent starts N sessions; each sends to the parent. Waiting for all N is the parent's own work, in a skill or a plugin; the kernel does not gather |
| Reviewer loop      | the session that started the reviewer sends it the change and sends the review back to the implementer; a skill counts the reviews                   |
| Nesting            | a session started by a session may start sessions itself; each sends to its creator, and management rights follow the creator chain                  |

**Left to plugins and skills**, never the kernel: gathering several results, loop and iteration limits, conditional
routing, teams and shared task lists, and handoff between agents.

## 2. Layers

**Packages.** Most workspace packages export `./*` → `./src/*.ts`, so an import names the module
(`@vibest/core/database/db`); `plugin`, `builtins`, the herdr SDKs and `integration/cursor` export named entries
(`@vibest/plugin/effect`, `@vibest/plugin/testing`). A module imports a name from the module that defines it (no re-exports of other
modules' names, except a domain facade re-exporting its own domain, see below).

| Package                 | Role                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                | Browser-safe contracts: branded ids, domain structs and errors, fact definitions (`event.ts`), the layout, `PROTOCOL` and `VERSION` (`version.ts`).                                               |
| `plugin`                | The plugin authoring API, as an Effect plugin (`effect/`) or a Promise plugin (`promise/`).                                                                                                       |
| `protocol`              | The single `RpcGroup` (effect/rpc, one JSON object per line), caller and peer headers, tagged errors, the contract in `contract/`.                                                                |
| `client`                | The Effect RPC client with the per-command preflight and auto-start, the socket connector, the release lookup (`release.ts`).                                                                     |
| `core`                  | The agent engine: persistence and the ledger, the Bus, sessions and their executions, the inbox, the plugin host, harness, runtime and agent catalogs.                                            |
| `server`                | vibestd: the RPC handlers, admission, the service graph roots (`services.ts`, `app.ts`), the socket and HTTP listeners, other machines (`machine/`), the hourly update check (`update-check.ts`). |
| `platform-bun`          | The Bun platform of the binary (`bun.ts`: the daemon `Host` and its `replacements`; `plugin-source.ts`). `packages/cli` maps `#platform` to it.                                                   |
| `builtins`              | The builtin plugins in load order (`pre`): the agent definitions, the Pi and Claude harnesses, the hc and herdr runtimes, runtime choice, `archive-on-idle`, `harness-default`.                   |
| `cli`                   | The `vibest` command: command specs (`commands/commands.ts`), one handler per command (`commands/handlers/`), the build. A vibestd client, plus `vibest daemon` through `@vibest/server/daemon`.  |
| `plugin-harnesses`      | The harness plugins `pi`, `claude` and the Cursor plugin file users add: one `HarnessDefinition` per CLI.                                                                                         |
| `runtime-herdr`         | The Runtime port on herdr (`terminal-runtime.ts`, `pool.ts`), herdr's saved machines, runtime choice.                                                                                             |
| `runtime-herdr-core`    | The Runtime port on herdr-core (hc).                                                                                                                                                              |
| `effect-herdr-sdk`      | Effect client for the herdr socket API.                                                                                                                                                           |
| `effect-herdr-core-sdk` | Effect client for the herdr-core socket API.                                                                                                                                                      |
| `integration/claude`    | The vibest Claude Code plugin (one hooks module), loaded with `claude --plugin-dir`.                                                                                                              |
| `integration/pi`        | The vibest Pi extension, loaded with `pi -e`.                                                                                                                                                     |
| `integration/cursor`    | The vibest Cursor CLI plugin (hooks running `vibest integration guard` / `stop`), loaded with `cursor-agent --plugin-dir`.                                                                        |

`packages/skills` holds the builtin Agent Skills (`delegate`, `pipeline`); `cli-darwin-arm64` and `cli-linux-x64` carry
the compiled binary.

**Dependencies.** What each package's `src` may import of the workspace:

```
schema               nothing
plugin               schema
protocol             schema
client               schema, protocol
core                 schema, plugin
server               schema, plugin, core, protocol, client
platform-bun         schema, plugin, core, client, server, builtins (and effect-herdr-sdk)
builtins             plugin, plugin-harnesses, runtime-herdr, runtime-herdr-core
cli                  schema, protocol, client, builtins, server/daemon (and HANDOFF_ENV of server/server), #platform
plugin-harnesses     plugin, schema
runtime-herdr-core   plugin, schema, effect-herdr-core-sdk
runtime-herdr        plugin, schema, protocol, client, effect-herdr-sdk
integration/claude   schema, protocol
integration/pi       schema, protocol, client
integration/cursor   nothing
effect-herdr-*-sdk   nothing
```

oxlint enforces the list with `vibest/package-imports` (`tools/oxlint/package-imports.mjs`, one map): it checks static
imports, re-exports, dynamic `import()` and type queries (`import("…").T`) in each package's `src`, refuses a relative
path that leaves the package, and lets only `commands/handlers/daemon/default.ts` take `HANDOFF_ENV` from
`@vibest/server/server`. Bun stays behind `platform/` directories, `bun.ts` adapters and `packages/platform-bun`
(`.agents/rules/bun-runtime-boundary.md`).

**Core layout.** As OpenCode lays out `packages/core/src`: a domain with several files has a root facade beside a
folder of the same name, and the facade re-exports its own domain's names; a one-file domain stays at the root.

| Where                                                                                                                                                                                                                                                                                                                       | Holds                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `session.ts` + `session/`                                                                                                                                                                                                                                                                                                   | Sessions: spawn, placement, executions, delivery, exits, archive, move, restart, entry, reconcile, locks, live state        |
| `plugin.ts` + `plugin/`                                                                                                                                                                                                                                                                                                     | The plugin host: sources, supervisor, registry, hooks, host                                                                 |
| `project.ts` + `project/`                                                                                                                                                                                                                                                                                                   | Projects: create, identity, activity                                                                                        |
| `database/`                                                                                                                                                                                                                                                                                                                 | `db.ts` and its domain modules (`project`, `session`, `inbox`, `remote`), the journal, projectors, ledger reads, migrations |
| `effect/`                                                                                                                                                                                                                                                                                                                   | `LayerNode`, the platform tokens, `bounded.ts`, `keyed-mutex.ts`                                                            |
| `subscriptions/`                                                                                                                                                                                                                                                                                                            | Harness subscription usage (`Subscriptions`, served by `vibest subscriptions`)                                              |
| `bus.ts`, `reactor.ts`, `inbox.ts`, `batch.ts`, `harness.ts`, `models.ts`, `agents.ts`, `runtimes.ts`, `caller.ts`, `launch.ts`, `remove.ts`, `replies.ts`, `system-prompt.ts`, `integration.ts`, `guard.ts`, `git.ts`, `worktree.ts`, `repository-url.ts`, `processes.ts`, `identity.ts`, `paths.ts`, `drain.ts`, `app.ts` | One-file domains                                                                                                            |

## 3. Core domain

The database and its facts are specified in [schema.md](schema.md); this section names the concepts.

```
Project ──< Session ──< Process    (one live at a time; a harness run in a terminal)
   │           │  └──< Execution   (one open at a time; one input handled until it ends)
   │           └──< Inbox row      (text for the session)
   └─ entry session → one of its sessions
Session.parent → the session that created it (none: the user)

AgentDefinition    Harness    Runtime    Machine
```

| Concept             | Meaning                                                                                                                                                                                                                                                   | Key fields                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Project**         | The directory vibest starts in, found by its realpath. A single repository is a project as it is; a plain directory whose direct children are repositories is one project of several repositories.                                                        | `id`, `directory`, repositories (`path`, `remote_url`), `entry_session_id`                                                                 |
| **Session**         | One conversation with a CLI agent in its own directory (a vibest-made detached worktree, or the project root for the entry session). It lives until it is archived; its parent is the session that created it.                                            | `id`, `project_id`, `parent_session_id?`, `agent`, `name`, `directory`, `created_at`, `ended_at?`, `origin_*` (started by another vibestd) |
| **Process**         | One run of the session's harness in a terminal. A session has at most one live process; a restart, a usage-limit move or an exit ends it and a new one starts.                                                                                            | `harness`, `provider?`, `model?`, `routing?`, `runtime`, `terminal?`, `pid?`, `conversation?`, `started_at`, `ready_at?`, `end_reason?`    |
| **Execution**       | One input a session handles until it ends. At most one is open per session. Its input is the text typed into the pane or the inbox rows delivered with it.                                                                                                | `typed?`, `accepted_at?`, `outcome?` (`completed` \| `failed` \| `interrupted` \| `lost` \| `not_started`), `failure?`, `reply?`           |
| **Inbox row**       | Text for one recipient session. `task` is its first input, `send` a message from the user or from a session to its creator or a session it started, `notice` something vibest tells the recipient about a session. Accepting and delivering are separate. | `kind`, `sender_session_id?`, `content`, `status` (`pending` \| `delivering` \| `delivered` \| `failed` \| `dropped`), `execution_id?`     |
| **AgentDefinition** | What a session is introduced with: a system prompt and a guard, registered by a plugin.                                                                                                                                                                   | `id`, `description`, `system`, `guard?`                                                                                                    |
| **Harness**         | Adapter for one CLI, registered by a plugin as a `HarnessDefinition` (§8). The runtime maps its id to its own agent kind.                                                                                                                                 | `id`, `inbox?` (`poll` \| `subscribe`), adapter functions                                                                                  |
| **Machine**         | Another vibestd this one can start sessions on and send to (`vibest connect`; multi-machine.md).                                                                                                                                                          | `name`, target, connection state                                                                                                           |

- **Parent, not controller.** A session's parent is the session that ran `vibest run`. A session sends only to its
  parent and to sessions it started; the user sends to any session of the project. Management (`interrupt`, `archive`,
  `peek`) belongs to the user and to the nearest living creator. The core defines no orchestration pattern; plugins
  shape what happens through hooks (§7).
- **Entry session.** One per project, the session a bare `vibest` reopens (`project.entry_session_id`). It records its
  executions like every other session. `vibest --new` starts a new conversation as a new session and ends the old one
  (`session.ended` reason `replaced`).
- **Project folder** (`VIBEST_PROJECT_DIR`, `projects/<project id>/` under `VIBEST_HOME`): `preferences.md` (how the user
  likes work done), `docs/`, `memories/` and `artifacts/`, read and written by every session of the project with its own
  file tools; the guard keeps each session to its own project's folder. `preferences.md` is added to every session's
  rules (16,000 characters). Memories are an index of at most 200 lines, not the file text.
- **Conventions:** project and session ids are UUIDv4 strings (people see the first 8); times are epoch
  milliseconds; archiving is a timestamp; `outcome` is the finished state of an execution. Execution statuses and inbox
  statuses are fixed enumerations: plugins observe them and cannot add values.
- **Not stored:** a copy of the CLI's conversation: the CLI owns its
  conversation, and who spawned whom is `parent_session_id` (schema.md, Not stored).

### 3.1 Lifecycles

**Session:** created by `vibest run` (or the bare `vibest` launch), then alive until `vibest archive` (`ended_at`) or
`vibest --new`. Archiving is final: nothing sent afterwards brings it back.

**Status** is `AgentStatus`: `idle | working | blocked | done | unknown`, the five values herdr reports. For a harness
with an integration, `working` is the time between `execution.started` and `execution.ended`, plus `blocked`; for one
without, the runtime's status is passed through. vibest adds no status values and no state machine over it.

**Process:** `started → placed? → ready → ended` with an end reason (`exited`, `limited`, `restart`, `move`,
`archived`, `launch_failed`, `superseded`). One live process per session.

**Execution:** opened when a delivery hands text over, or when the user types into a pane with none open, and closed by
the harness's end report or by vibestd (`lost`, `not_started`, `interrupted`, an exit). Idle is not an end: vibest does
not model the CLI agent's internal loop. A piece of work ends when its integration reports the end of its work (Claude
`Stop`, Pi `agent_settled`, …) and the session's inbox is empty; then the next rows are delivered. For a harness with an
integration, the runtime reporting idle with no report for 10 s makes the execution `lost` (a reason and the
`vibest peek <id>` command, never screen text; the last 30 lines go to vibestd.log). A harness whose definition has no
`executionEnd` treats the runtime's idle as the end: an execution vibest handed over, or one the runtime saw start with
none open, is `completed` the moment the runtime reports idle, with no reply text and no way to tell an error from an
answer; `blocked` keeps it open. Such a harness is ready for its first task only once the runtime reports idle (not
blocked on a login or a dialog).

**Outcome of an inbox row's execution:** `completed` or `failed` by the harness, `lost` as above, `not_started` when
delivery could not be confirmed (§3.2), `interrupted` by `vibest interrupt`.

**Answers** come through the best channel (D11): the integration sends its execution-end event to vibestd, which writes
the harness's last reply (Claude `last_assistant_message`, Cursor and Pi `text`) in the execution's `execution.ended`;
the projection keeps it as `reply`, read with `vibest result` and shown in `vibest ls`. Nothing is sent to anyone: a
session that has something to say runs `vibest send <id>`.

**Notices** say only what a session could not say itself: its harness exited, it never started, an execution ended in an
error, it waits on a permission, a message to it was not delivered, it was archived. A notice goes to the nearest living
creator (its parent, else the parent's parent, and so on; a creator on another machine through the outbox; none left,
only the user reads it). A sent message that cannot be delivered goes back to its sender as a notice.

**Archive on idle** (`vibest run --archive-on-idle`): the session is archived the first time it is idle after a
completed execution with nothing waiting (§3.3).

### 3.2 Execution

- **Inbox.** One lock per recipient session; read the pending rows, deliver, mark `delivered` only on success.
  Consecutive rows from one sender are delivered as one. Triggers: a row written, the recipient's status event, vibestd
  start and a runtime registering or coming back. A `blocked` recipient gets nothing.
- **Pull or type is a property of the harness.** A harness whose definition declares `inbox` (`poll` for the Claude plugin
  over HTTP on `vibest-http.sock`, `subscribe` for the Pi extension's subscription stream) pulls; the integration asks
  for the next batch with `take` only while its session is idle, and the subscription stream carries only a wake-up.
  Any other harness is typed through the runtime's prompt. The entry session and spawned sessions follow the same rule.
  `take` runs in one transaction: with an execution open it answers empty; otherwise it opens the execution, marks the
  batch `delivered` and attaches it to that execution. The integration reports the execution accepted when the batch
  reaches the model; a batch never used is settled by the confirmation timeout like a typed one (`not_started`). A
  session with no process is resumed by the typed path's wake-up and then takes its message.
- **Typed delivery**, text unchanged, then confirmed: within 8 s the state sequence must move or the agent must be
  working; otherwise press Enter and wait 8 s; otherwise paste once more and wait 8 s; otherwise `not_started` with a
  notice naming `vibest peek <id>`. No screen text is ever pushed to a session: one reads a terminal on demand with
  `vibest peek <id> [--lines N]`; vibestd.log keeps the tail.
- **Failure.** A row that cannot be delivered is finalized `failed` and its text returned to the sender as a notice,
  once. A row found `delivering` after a restart is finalized `failed` with "may or may not have arrived": never
  replayed blindly. A runtime unreachable before handover leaves it `pending`.
- **Exited session.** Sending to a session whose process exited opens a terminal in its directory and resumes the CLI
  conversation with the harness's resume arguments; without a known conversation id it fails.
- **Restart.** On start, vibestd subscribes before writing anything, settles the deliveries a stop cut off, labels
  terminals again, then checks every live session once (the same check runs when a runtime registers or comes back); a
  session whose process is gone gets an exit recorded; orphan worktrees are logged, never deleted.

Session work lives in `packages/core/src/session/`, one `Context.Service` per module, each depending only on the ones
below it and subscribing to the events it handles itself:

| Module                         | Holds                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `locks.ts` (`SessionLocks`)    | the per-session and per-directory locks                                                          |
| `live.ts` (`SessionLive`)      | per-session memory: tracked flags, restarting, statuses, integrations, `--archive-on-idle` marks |
| `executions.ts` (`Executions`) | typing a prompt, waiting for ready, interrupting a harness, closing an execution                 |
| `placement.ts` (`Placement`)   | the worktree, environment, system prompt and argv of a start; opening the terminal; notices      |
| `move.ts` (`Move`)             | moving a session to another harness after a usage limit                                          |
| `archive.ts` (`Archive`)       | remove, the idle-archive check, finishing an archive vibestd stopped in                          |
| `delivery.ts` (`Delivery`)     | send, queued inbox rows, the next batch after an execution, interrupt, typed prompts             |
| `exits.ts` (`Exits`)           | recording a harness exit and what a usage limit leaves behind                                    |
| `spawn.ts` (`Spawn`)           | admitting and starting a session, `VIBEST_MAX_SESSIONS`                                          |
| `reconcile.ts` (`Reconcile`)   | checking a session against its runtime, timers, startup `republish` and `reconcile("all")`       |
| `restart.ts` (`Restart`)       | restarting sessions whose harness or vibest is outdated, the entry argv                          |
| `entry.ts` (`EntrySession`)    | starting and resuming the entry session                                                          |

`packages/core/src/session.ts` (`Session`) is the facade the server and the CLI call: it delegates to these modules and
itself only reads (`get`, `list`, `peek`, and `view`, which adds a session's directory and git state).

How these modules keep the rules:

- Every operation on one session runs under that session's lock; different sessions proceed in parallel. A
  session directory has its own lock (`directory:<path>`), which an archive holds while it decides whether the
  directory goes and a `--share` spawn holds while it joins it. Per-session flags live in memory and are dropped once
  the session is no longer live and nothing is in flight on them (`forget`, under the lock).
- Archive closes the execution and marks the session archived and exited under its lock. The aborted execution
  end their interrupt causes, landing during the interrupt or after the archive, writes nothing: an interrupted end
  with no open execution is dropped (`db.session.endObserved`).
- Ready for input: a harness whose integration reports ready is ready once that report is on its row (a restart or
  move removes the previous one); any other once the runtime's state is idle, working or blocked. While neither (a
  harness starting, or a startup dialog such as Claude's folder trust) the harness's startup step answers it, polled
  every 500 ms because a drawn dialog has no event. A runtime without `state` and a harness without a report are
  ready when `open` returned. What the terminal showed goes to vibestd.log only.
- Handing over an execution: the execution opens after the wait for ready, right before the text goes, so a session
  that never gets ready leaves no execution and takes no rows; one already open when the lock was taken is reused, and
  one a prompt typed during the wait opened is not, so the text waits for it to end. The execution is open, and the
  subscription to its state taken, before the runtime gets the text, so the paste's own prompt hook is ignored and
  no execution start can come before the wait on it. Only this execution's acceptance confirms pickup: the previous
  execution's start would confirm a text whose Enter was swallowed. The text is pasted again once only, so a task never
  runs twice. A refused text undoes the execution unless the integration wrote a result anyway or a usage-limit move
  will try the next harness; a broken connection is not a refusal (the text may have arrived), so the execution stays.
- A check decides nothing for an exited session (the next row resumes it), an archived one, or one whose harness
  vibestd is restarting. A delivery already waiting on that session does not resume once the exit has failed its
  queued sends; it decides only after that, and the next message is what resumes it. A delivery that finds the
  terminal gone before any exit was recorded records that exit first (the check), so only a recorded exit is ever
  resumed. An interrupted execution end reported once the session's terminal is closed is the harness aborting as it
  exits (Pi aborts its execution on SIGHUP before it shuts down): it is not written, and the check records the exit
  in its place, so the result does not depend on whether the report or the runtime's exit event comes first.
  Unreachable or `unknown` status is no answer. No agent, while that terminal's process is
  running, is not an exit: the shell may still be starting it. That keep arms one re-check after the start
  timeout; the re-check does not arm another, and it still exits only if the runtime then reports the process gone.
  A harness whose reported
  pid has died is an exit even when that report still says the terminal is running: a launch herdr has not finished
  keeps saying so after the process was killed. A terminal the runtime cannot
  find is. An execution counts
  as worked when it was accepted (seen working, or a start of it was reported) or typed. Idle and never seen working: look again after the confirm timeout. Idle after working with no report: lost
  after the hook grace. A prompt that failed part way closes the execution so the queue moves again.
- A row stays queued only for what a retry can fix (the runtime unreachable, vibestd stopping); a refused start
  is final. A session whose harness is being restarted is never resumed in another terminal.
- Placing a start (`session/placement.ts`): the session's `process.started` is written before its terminal exists, so what the
  harness reports while it starts (ready, its pid) belongs to it; a terminal that never opens ends it as
  `launch_failed`. The worktree comes first: the terminal's cwd is in it, the argv names it, and the
  `.worktreeinclude` files are in place before the harness starts. It is detached and made by vibest (a linked
  worktree of the main checkout would group away from the project's terminals); a multi-repository project gets one
  detached worktree per repository. A failed start undoes its steps in reverse order, uninterruptibly, before the
  failure becomes a notice: the terminal, the system prompt file, the worktree (with git, without force; a refusal,
  or a reserved directory git left something in, stays for `vibest archive`). A failed resume closes its terminal
  too. A terminal opens beside `--share`'s, else beside the entry session's when that runs in the same runtime. When a
  project's last live session ends, the entry session's terminal publishes the workspace alone; without a stored
  project directory its name cannot be given again and is left as it is (a known gap).
- Starting the entry session (`launch.ts`): every check that can refuse the launch (harness, provider, binary, plugin,
  temporary directory) runs before the entry session is recorded, since that supersedes the running entry
  session's launch. The shell a launch opens at the root runs the command and then stays, so a failed start (or an
  entry session the user quits) leaves its error and a shell, not a closing terminal. `VIBEST_HOME` is set last in its
  environment, so a caller's `--env` cannot point that shell at another vibestd.
- The start-up reconcile does not archive `--archive-on-idle` sessions: that flag lives only in the memory of the
  vibestd that started them, so after a restart they stay until archived by hand (schema.md, Memory).

How an execution ends:

- An execution end the harness reports (`db.session.endObserved`) is written as it arrives, without the session lock, in one
  transaction: the `execution.ended` with the reply and the conversation, the session idle, and the error notice for a
  failed end that is not a usage limit. It is ignored for a harness the session no longer
  runs, before the current process's ready report when its harness reports ready, and when it is interrupted with no
  execution open. A completed or failed end with no execution open is an execution of its own (an execution typed in the terminal whose
  start was missed). vibestd's own closes (`lost`, `not_started`, `interrupted`, an exit) are conditional on the
  execution they decided about still being open (`db.session.closeExecution`), so an observed end that came first wins and the close
  writes nothing, notice included. A reply that arrives after vibestd closed the execution as `lost` is a new execution; it
  is not attached back. A usage-limit end closes its execution `failed` with failure kind `limit`; check then moves the session to the
  next harness, which resends the input in a new execution, so a limit is two executions. A move vibestd stopped part
  way through is finished by the next check, from the limited execution's process and the current one: the limited
  process still current is moved; a next process that runs gets the input handed to it, with no other started; a
  next process that ended, or a limited process that ended with none after it, is moved again (a session whose process
  ended this way is checked at start too); a move that finds no harness tells the parent.
- Reports from a harness carry the process id vibestd started it as, and an execution end or start from an earlier
  process of the session is dropped (schema.md). An end that arrives while the open execution is not accepted yet is
  earlier activity and changes nothing.
- Queued rows: one wake is one delivery; the batch goes pending, delivering, delivered, or failed with the sender
  told. A broken connection before the handover leaves it pending for the next check; after it, the text may have
  arrived, so it is not sent again and the sender decides.
- Text the user types while no execution is open opens one (no inbox row). It is stamped when the hook arrives, before
  the session's lock is taken: the lock can be held for seconds (a delivery, an interrupt, an archive) and the typed
  execution may already be over when it frees, and a later stamp would drop that execution's reported end. vibest's own paste
  sets a flag around its send, so that echo is no execution and the hook cannot deadlock on the lock the paste holds. An
  execution that opened after the read is not recorded twice.

### 3.3 Ending and cleanup

`vibest interrupt <id>` sends the harness's interrupt key and waits up to 10 s for the execution to end; the session,
its terminal and its worktree stay. `vibest archive <id>` (`remove.ts`, `processes.ts`, `worktree.ts`):

1. marks the session archived first, so from then no send, check or resume brings it back; a session that already
   exited is not closed again;
2. interrupts if working, closes the execution, and fails its pending rows with one notice;
3. reads the session's process tree (harness pid, its descendants, and the shell that is its parent), closes the
   terminal (if it is the last one of a main checkout's workspace, it is first moved alone into a new workspace,
   because closing it would close the whole herdr worktree group), then gives those pids 10 s to exit;
4. removes the session's worktree only when it is a listed worktree under vibest's worktrees root, no other live
   session shares it, no process (lsof cwd scan) is inside it, `git status` is clean, and HEAD is on a branch or
   remote ref; `git worktree remove` without force; branches are never deleted. `--keep-worktree` keeps a clean one.
   A kept worktree is named with its reasons, and the archive is still finished.

How `packages/core/src/remove.ts` and `processes.ts` keep this:

- Every fact that guards a destructive step is asked right before that step, never reused from earlier: git state
  and live sharers are read again right before `git worktree remove`. Only a directory under vibest's worktrees root
  is removed; a row with no directory recorded closes nothing and removes nothing.
- vibest never signals a process it found or recorded. The runtime's close sees a terminal's processes off (by
  contract; vibestd still proves it by cwd before the worktree goes), and a close that failed proves nothing. The
  only signal vibest sends is SIGTERM to one harness pid it was told (a restart, a usage-limit move, an entry session
  moving terminal), never its group. A reused pid reads as alive, which can only keep more.
- Before that close, on this machine only, the session's process tree is read (`ps -x -o pid=,ppid=,comm=`). After the
  close those pids get 10 s to exit, by the liveness probe only. A tree `ps` could not read is not waited on. A process
  that is not in the tree is not waited on either: the one cwd listing below keeps the worktree as soon as it names one.
- The cwd check is one lsof run (`lsof +w -a -u <uid> -d cwd -FpRcfn0`, no shell) in its own process group, cut off
  after 10 s, then SIGTERM and SIGKILL 1 s later; a helper stuck in uninterruptible I/O holds the run until it
  returns. The listing is trusted only when lsof exited 0 with nothing on stderr (warnings mean a partial listing),
  every set is well formed, no name is lsof's `(readlink: …)` or `(stat: …)` diagnostic, and vibestd's own process
  is in it with its cwd (a sanity check, not a proof of completeness). One exception keeps Linux hosts with a systemd
  user manager answerable: that manager (`systemd`, started by pid 1) and its `(sd-pam)` child run as the user but no
  one can read their cwd, so their `/proc/<pid>/cwd (readlink: …)` names are skipped; any other unreadable cwd, a
  `(stat: …)` name, or one of them without its command and parent still makes the listing unknown. Ceiling: a program
  of the same user that names itself `systemd`, is reparented to pid 1 and turns itself non-dumpable could hold the
  worktree unseen. A name lsof printed with escapes, or a
  `(deleted)` cwd, counts as a holder of anything in the worktree it could stand for.
- An entry session stopped so it can start in another terminal (`Project.StopEntry`): its row leaves its place
  first, so the harness's exit drops nothing, and from there to the answer the stop is uninterruptible, so a Ctrl-C
  cannot leave the row detached while the harness runs. It is signalled only while the runtime sees an agent in that
  terminal, and a harness still there after 10 s gets its row back. Ceiling: local machine only (a pid names a
  process on vibestd's machine; a remote one needs a runtime operation), and a pid reused by another program while
  the runtime still sees an agent there would get the signal.

Rows are never deleted. `vibest ls` lists sessions that have not ended; `vibest ls --all` and `vibest result <id>` still
show an ended one.

A spawn reserves its worktree name with an atomic `mkdir`; a start cut off before its terminal was recorded is undone
as a failed launch (its worktree goes when nothing can be lost, its reserved directory when still empty), while a
resume or move falls back to its previous start.
`--archive-on-idle` decides under the session's lock, at a completed execution end and whenever a row it sent or was
sent leaves `pending`/`delivering`: a session with work again (a queued row, a row still waiting in either direction,
or a newer execution) stays, and a clean archive sends no notice, since each notice is an entry session execution.
The builtin plugin `archive-on-idle` subscribes to those facts and calls that check; `"-archive-on-idle"` removes the
plugin, and the flag then archives nothing.

## 4. Patterns

The core knows no patterns. A session that starts and directs others does it with the commands the CLI has (`run`, `send`, `result`, `ls`, `interrupt`, `peek`, `archive`):

- **Delegation** (§4.1) is the product: the entry session starts sessions and reads what they send back.
- **Flows over several sessions** are skills (§4.2): instructions the session that runs them follows with the same
  commands, so the user sees and can step into every step.
- **Rules that must hold every time** are plugins on hooks, or the guard of an agent definition (§4.3), not programs:
  they refuse, transform, or decide at one hook point.

There is no workflow engine. Someone who wants a fixed script writes it outside vibest, as an ordinary client of the
CLI.

### 4.1 Delegation

The product, and the base of every skill; needs no plugin beyond the builtin agent definitions.

```
you ──chat──▶ entry session
                │ vibest run "…"                       ← started by the entry session
                ▼
              new session ── works; its integration forwards its executions to vibest
                │
                ▼
              the session runs `vibest send` when it has something to say
                ▼
entry session's integration delivers it as new input     ← back in the conversation
```

- **Entry session.** An ordinary session: one CLI conversation with the same lifecycle, integration, hooks and inbox
  as any other. Only one thing marks it: `project.entry_session_id` points to it. Bare `vibest` in a Project directory
  opens it as the `coordinator` definition, creating it on first use and resuming it if its pane is gone. The user chats
  with it like with any CLI agent.
- **Starting sessions.** Any session runs `vibest run [<harness>] <prompt>`; a run with no calling session is refused,
  so the user opens a session with bare `vibest` first. Without `--agent` the new session runs the `general` definition.
  The new session's parent is its caller. Its replies are not sent anywhere: it reaches its parent with `vibest send`,
  and the parent reaches it the same way.
- **Ending or keeping.** A session stays for follow-ups through `vibest send` until `vibest archive`;
  `--archive-on-idle` archives it the first time it is idle after a completed execution with nothing waiting (the
  builtin plugin `archive-on-idle`). `VIBEST_MAX_SESSIONS` limits how many run at once.
- **Waiting.** Skills do not poll or block: a CLI's shell tool times out long before a session finishes, so what a
  session sends comes back through the inbox.
- **Where a session works.** In its own new linked git worktree, detached at the caller's HEAD; `--share <session>`
  runs it in another session's directory, in a pane split from that session's pane (a reviewer shares the
  implementer's worktree).
- **Stepping into a pane** is allowed, also after the session answered. If no execution is open, what the user types
  starts one; the entry session reads it with `vibest ls` and `vibest result`.
- **What the entry session knows.** `vibest ls` gives every session that has not exited, with its task, live status and
  latest execution, so the entry session recovers the whole picture after compaction or a restart without relying on
  its context.
- **Session rules.** The `general` definition's prompt (`packages/builtins/src/agent.ts`): work on a detached HEAD, then
  branch, commit and push when done; destructive git or file actions need the user's quoted consent; never control
  herdr; shared files go to the project folder's `artifacts/` prefixed with the session id.

### 4.2 Skills

A skill is a `SKILL.md` instruction document for an agent. vibest has only builtin skills, `delegate` and
`pipeline` in `packages/skills/`; it loads no skill directory of the user or of a Project. The build copies them into
each harness's vibest plugin: Claude Code loads that plugin (`--plugin-dir`) in every session, and each skill's
description says only the entry session uses it; Pi's vibest extension returns them from `resources_discover`. Skills
the user installed in the CLI itself stay the CLI's own.

| Skill    | The session that follows it…                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delegate | splits work, runs sessions, keeps talking with the user, checks each message when it arrives, reports                                                                                                                                                                                                                                                           |
| pipeline | runs a read-only planner; shows the plan to the user and waits for agreement; passes the plan, verbatim, to an implementer; runs a reviewer in the implementer's worktree (`--share`) and sends its comments back to the same implementer until the reviewer approves or the user decides (at most three reviews); then has the implementer open a pull request |

**Three ways to use them**, most used first:

1. Just say what you want; the entry session picks a skill from its description.
2. Name it: invoke the skill in the CLI (`/pipeline …`) or say "do it as a pipeline".
3. Rules that must hold every time go in plugins or guards (§4.3).

**Adding a flow** (a committee, racing, an advisor) is a new builtin skill in `packages/skills/`. It needs no core
change, because every flow uses the same commands.

### 4.3 Rules

A rule is an ordinary plugin on one hook (§7), installed in the vibest home, or the `guard` of an agent definition,
which refuses a tool call of a session that runs it (the `coordinator` guard refuses file edits outside the project
folder).

## 5. Service composition

- Each module exports itself as a namespace (`export * as Inbox from "./inbox.ts"`) holding its `Service` (a
  `Context.Service` class), `Interface`, `layer`, `node` and, with options, `configured`, as OpenCode does. The
  rules are in [`.agents/rules/effect.md`](../../.agents/rules/effect.md). A host input the module needs (such as
  `Identity.HostFacts`) keeps its own class with a `<name>Node` beside the module's service.
- Services are assembled from a **service graph**: each entry is a `LayerNode` node listing its `deps`.
  The graph compiles to one `Layer`.
- Configuration replaces entries at the composition root (`PlatformNode.sqlClientLayer.replace(…)` in
  `packages/platform-bun/src/bun.ts`).
- Implemented with `LayerNode` (`packages/core/src/effect/layer-node.ts`, ported with its tests from OpenCode's
  `packages/util/src/effect/layer-node.ts`, MIT, Copyright (c) 2025 opencode; `unbound` is infallible).
  Its release tracking is kept: `LayerNode.Releases` records each node whose layer is still releasing, and when
  shutdown passes its deadline the daemon prints them (`server/src/daemon.ts`, `server/src/shutdown-deadline.ts`). Each service has a `node` listing its `deps`; what the host supplies
  (the platform services, the daemon's identity) is an unbound node. The SQL client, the socket server and the HTTP
  server can fail to open, so the host supplies each as an infallible layer token (`SqlClientLayer`,
  `SocketServerLayer`, `HttpServerLayer`: an unbound node whose value is a `Layer`), and a real provider node
  (`sqlClient`, `socketServer`, `httpServer`) consumes the token and carries the failure (`DatabaseOpenFailed`,
  `SchemaMismatch`, `SqlError`, `SocketServerError`, `ServeError`) in its type; a host that omits a token is
  refused when the graph is compiled. The roots are `services` (`packages/server/src/services.ts`) and `daemon`
  (`packages/server/src/app.ts`), which adds the RPC and HTTP servers. The daemon compiles `daemon` and the tests compile `services`, each with its own
  replacements. The platform (`packages/platform-bun/src/bun.ts`) exports `replacements` for everything it supplies
  (platform services, sqlite, the sockets, the machine transport, the plugin loader, the builtin plugins, the host
  environment, the process platform, the host facts); its `Host` keeps only `lock` and `checkDatabase`, which run
  before the graph is built. The daemon adds its `Layout`, `Identity` and `Shutdown`. The vibestd identity is the first root, so a malformed identity file stops vibestd before the database is opened. Dependencies of one node build concurrently and a group's roots build in order; a replacement drops
  the replaced node's own dependencies, so a fake is never built beside the real service.
- There is one scope, the daemon: the database and its ledger, the Bus, projects, machines, sessions and their
  executions, the inbox, the plugin host, and the harness, runtime and agent catalogs are the same for every Project.

## 6. Persistence and events

All state is in one SQLite file, `vibest.db`, as described in `schema.md`:

- SQLite, WAL, STRICT tables, all SQL in the `Db` service. The database carries an `application_id`, the catalog
  version that last wrote it and the migrations applied to it; a file that is not vibest's, or written by a newer
  catalog, is refused before any writable open (`SchemaMismatch`), leaving it untouched. Pending migrations run in
  order when it opens (schema.md, Opening and migrations).
- The check runs on a read-only connection, which sees committed WAL frames and does not checkpoint, so a refused
  database and its WAL keep their bytes (the WAL index, `-shm`, may still change). WAL mode stays off until `Db`
  accepts the file. A missing database is created mode 0600, and each open forces 0600 on the database and any
  existing `-wal` / `-shm` (SQLite copies the database's mode onto those it creates later). A writable transaction
  is `BEGIN IMMEDIATE`, with a 5 s busy timeout.
- The append-only `event` log of facts (`docs/design/schema.md`) is the state; the read-model tables (`project`,
  `session`, `process`, `execution`, `inbox`, and the machine tables) are projected from it in the same transaction.
  The Project's entry session is `project.entry_session_id`; a session's task is its `task` inbox row; its live status
  comes from the integration's events and, for a harness with no integration, from the runtime (memory only). Facts
  are never deleted.
- Files keep one writer each and are written to a temporary file and renamed: system prompt files by vibestd; never
  the user's harness configuration.
- Not stored: worktree branches and dirty state (asked from git), terminal state (asked from the runtime).
- Events reach the reactions through one in-memory Bus (`core/bus.ts`): the Bus itself appends facts (`Bus.publish` inside `Bus.transaction`), applies each through the projector its domain registered
  (`bus.project`, from `project/`, `session/` and `remote/` `projector.ts`) and publishes a committed transaction's facts
  in seq order, and observations the schema does not store (signals: `terminal.*`, `runtime.reset`, `session.changed`, `project.changed`) are published only. `bus.subscribe(definitions)` enqueues only the requested types, in publish order across them; `bus.subscribe()` takes every event. A waiter subscribes before
  the action whose consequence it waits for (`awaitEvent` before its first look), so an event in between is not lost.
  The Reactor (`core/reactor.ts`, a scoped constructor each reacting service calls: `reactor.on([definitions], handler)` hands the handler the typed event) knows events, not sessions or projects: each handler runs in a fiber of its own, a
  failing one is logged and stops nothing else, and none depends on the order events arrive in. Each re-derives what
  to do from storage under its session's lock, so a late or repeated event finds the work done or redoes it once.

## 7. Plugin architecture

**Definition**: a plugin is an id and either an effect or a Promise setup, one per entry point as in OpenCode:
`@vibest/plugin/effect` (`packages/plugin/src/effect/plugin.ts`) defines `{ id, effect }` and `@vibest/plugin`
(`packages/plugin/src/promise/plugin.ts`) defines `{ id, setup }`; `Plugin.define` takes one shape each. The domain types
both use (`domain.ts`) are exported from both.

```ts
export interface Plugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
```

A `setup` plugin is turned into an `effect` plugin when it is set up (`packages/plugin/src/promise/adapter.ts`, as OpenCode's
`promise/adapter.ts`), so both forms share one loading, failure and reload path. Its Promise `Context` has the same
domains with Promises: `hook` callbacks return a `Promise` or a plain value and refuse by throwing `AgentRefused`;
registrations resolve to `{ dispose(): Promise<void> }`; `event.subscribe` is an `AsyncIterable`, closed when the plugin
unloads; `subscription.report` returns a Promise; `transform` takes the same synchronous editor (runtime and harness
definitions stay Effect types, so their authors write Effect). The `Cleanup` that `setup` returns runs when the plugin's
scope closes; registrations made later, from inside `setup`, still belong to that scope.

**Two capabilities**, as OpenCode: `transform(editor)` with a synchronous editor (`add`, plus `update` on the harness
editor), and `hook(name, callback)` for live interception. Both return a `Registration` (`{ dispose }`) owned by the
plugin's scope: unloading the plugin disposes everything it registered, and `dispose` may be called earlier (a second
call is a no-op). Registries are `packages/core/src/plugin/registry.ts`: transforms apply in registration order on a lazy
rebuild, a plugin's setup runs in one `group` (a throwing transform disables the whole plugin and removes its earlier
registrations; a disabled plugin is not set up again until its own revision or options change), and an activation runs
in one `batch` (one rebuild and one notification however many plugins changed). Removing a plugin's transform restores
the definitions it changed or removed. Editor callbacks are synchronous: load effectful data before registering a
transform.

**Context domains** (`packages/plugin/src/effect/plugin.ts`):

| Domain         | Members              | Edits                                                               |
| -------------- | -------------------- | ------------------------------------------------------------------- |
| `options`      | the plugin's options | —                                                                   |
| `agent`        | `hook`, `transform`  | hooks `start.before`, `fail`; `AgentDefinition`s by `id` (`add`)    |
| `machine`      | `hook`               | `connect`, `remove` (multi-machine.md)                              |
| `runtime`      | `transform`          | `RuntimeDefinition`s by `id`, each with its optional `caller` (§10) |
| `harness`      | `transform`          | `HarnessDefinition`s by `id` (§8)                                   |
| `subscription` | `report`             | one `(harness, provider)` row's limits                              |
| `event`        | `subscribe`          | — (observes the ledger's facts)                                     |

An `AgentDefinition` is `{ id, description, system, guard? }`: the prompt a session of that definition starts with and
its optional pre-tool guard. The builtin plugin `vibest.agent` registers `coordinator` and `general` with it.

**Observing facts.** `ctx.event.subscribe({ types? })` is a `Stream` of the ledger's own facts (`Fact` from
`@vibest/schema/event`: `seq`, `at`, `type`, `projectId?`, `sessionId?`, `data`), taken from the post-commit `Bus`. A plugin
observes facts and gets no SQL, no `Bus.publish` and no projector of its own. Only catalog facts reach it: every signal is
filtered out. `types` omitted or empty means every fact; an unknown type is logged and ignored, and a non-empty list of
only unknown types is a stream that never emits. Delivery is on this machine only, only after the commit, and live from
the moment the stream is run (no replay, no cursor, no ack); a replaced or unloaded plugin's stream ends with its scope.
A plugin runs its consumer in its own scope (`Effect.forkScoped`); the 5 s setup bound covers starting it, not its life.

**Agent hooks** (one hook domain: `context.agent.hook("start.before" | "fail", ...)`):

| Hook                 | Changes (by assigning to the event)                                   | Runs                                                    |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent.start.before` | any of `prompt`, `harness`, `provider`, `model`, `machine`, `runtime` | before every session starts, the entry session included |
| `agent.fail`         | `move` (`{ harness, provider?, model? }`)                             | a started session's execution failed with a usage limit |

Every event carries the project, the agent definition's id, the parent session, the harnesses and whether each can start,
the current Subscriptions, and the earlier tries. A callback returns nothing and changes the event by assigning to its
fields. Each callback gets its own copy of the event as decided so far and core copies the changed fields back only when
the callback succeeded within its deadline, so a callback that times out, fails or writes after its deadline leaves no
partial or late write. Callbacks run sequentially in plugin order, so a later plugin sees (and may override) what an
earlier one decided. On `agent.start.before` an assigned `undefined` unsets `harness`, `provider`, `model` or `runtime`,
and is ignored for `prompt` and `machine`; on `agent.fail` the last `move` assigned wins. The trace attributes each field
to the plugin that changed it last. Only `agent.start.before` may refuse: `Effect.fail(new AgentRefused({ reason }))`
stops the chain at once, nothing is inserted and nothing starts, and the caller sees the plugin id and the reason. A
defect or a timeout on either hook fails the operation (`plugin <id> crashed: ...`, `plugin <id> timed out after 5s`);
on `agent.fail` the execution is left failed with the plugin error and no move. Nothing is skipped silently.

**Default harness.** A session started without a harness inherits its parent's harness, provider and model in core,
before `agent.start.before` (§9). The builtin `harness-default` (last of the builtins) sets `harness` to `claude` from
`start.before` when it is still unset and claude is available; remove it with `"-harness-default"` in `vibest.json` and
choose in a plugin of your own. No builtin chooses or refuses a harness by quota; subscriptions are data in the hook
events for a plugin that wants to route by quota.

**Plugin API facts** (`@vibest/plugin`): vibestd maps this module and `effect` to its own instances when it loads a
plugin, so a plugin imports both normally and bundles neither. A plugin's `effect` runs once per load in the plugin's own
scope; what it registers (hooks, transforms) and acquires lasts until unload, and a hook name not in `Hooks` fails its
setup. An `effect` or a hook callback that throws instead of returning an Effect counts as that plugin's failure (a failed
setup, or `plugin <id> crashed: ...`), never as a defect of the activation or the call. In `subscriptions`, `provider` is
empty for Claude Code and Cursor and set for Pi; empty `limits` means unknown, not unlimited, and a login is limited when
any of its usage windows is. A remembered limit rules its login out until that login's own row was refreshed after it and
reads fine again. `subscription.report` replaces one `(harness, provider)` row's limits until the next usage poll of a
harness that reads usage. `agent.fail`'s `reason` is a union with one member, `limited`.

**Counters and traces**: per plugin and hook, calls, changes, crashes, timeouts, refusals, and the last error, shown by
`vibest plugins`; every trace entry is `{ plugin, hook, ms, outcome: "ok" | "refused" | "crashed" | "timeout", changes }`,
where `changes` is what that callback changed, field by field, with the value it replaced.

**Dispatch:** sequential in plugin order; each callback gets a copy of the event as decided so far, committed only on
success; every callback is bounded by a 5 s timeout (waiting on its fiber, so an uninterruptible region still returns on
time). Machine hooks differ: every subscriber runs, each bounded by 30 s (multi-machine.md).

**Registry and supervisor:** identity `(id, revision)`; reactivation keeps the longest unchanged prefix and rebuilds the
rest in order inside a batch; a new revision that fails to import with unchanged options leaves the running one as it is
(not torn down or set up again, and neither are the plugins after it) and `vibest plugins` shows both revisions, while
with changed options it is failed and the old one is not restored; one whose setup fails falls back to the previous one;
neither is retried until it changes; a plugin file found in the plugins directory and named in `vibest.json`, or named
there twice, is one plugin, at its first place with the options of its last mention. An activation latch gates
`agent.start.before` and `agent.fail`: they wait up to 10 s for the pending generation, and if it is still not active the
operation fails with `PluginsNotActive`, naming the plugins still loading, and does not run on the plugins already active.
`vibest plugins` reads the plugins already active and does not wait. Builtin plugins activate while vibestd's layers are
built, before it listens, so a request that routes to a builtin runtime never finds it unregistered. User plugins activate
afterwards, in the background, and a start during that activation is refused rather than admitted without them. A builtin
plugin's setup must not do I/O (it connects lazily, as `runtime-herdr` does), because every builtin setup runs before
vibestd listens and a slow one would push startup past the client's `DAEMON_START_TIMEOUT` of 10 s. Triggers are
configuration changes and module file changes, debounced by 100 ms, plus a re-read every second.

**Loading and watching:** local plugin changes reload without repeating unchanged imports; failed revisions keep the
previous one. See [loading and watching](plugin-loading.md#loading-and-watching) for watch and reload details.

**Loading on Bun:** plugins share vibestd's `effect`, `@vibest/plugin` and `@vibest/plugin/effect` instances while local
modules reload. See [loading on Bun](plugin-loading.md#loading-on-bun) for resolution and module lifetime details.

**Order:**

```
builtin plugins         `@vibest/builtins` `pre`: vibest.agent, harness-pi, harness-claude,
                        runtime-herdr-core, runtime-herdr, runtime-choice, archive-on-idle, harness-default
user plugins            the plugins directory (sorted by name), then `vibest.json` `plugins`, in order
```

**Where plugins live**: only in the vibest home (`VIBEST_HOME`, by default `~/.vibest`), in `vibest.json` and the
`plugins/` directory. There is no project tier: a project directory adds no plugins and no configuration.

**Plugin entries**: the ordered `plugins` list of `vibest.json`.

| Entry                                  | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"./plugins/x"`                        | add a local plugin: a directory, by a path starting with `/` or `file://` (absolute, taken as is) or `./` or `../` (resolved from the vibest home); a single file named here is skipped with a warning, single files are discovered in the plugins directory                                                                                                  |
| `{ "package": "…", "options": { … } }` | add a local plugin with options                                                                                                                                                                                                                                                                                                                               |
| `"@scope/vibest-plugin-x"`             | any other name is a package: not supported, listed as failed with `npm plugins are not supported yet`                                                                                                                                                                                                                                                         |
| `"-check"`                             | remove the plugins added before it whose id matches, builtins included (a builtin only by exact id; `*` and `prefix.*` match user plugins only, `*` also failed ones). Builtins are kept or removed from the config text at every activation, so removing and restoring one needs no restart. Example: `"-harness-default"` drops the builtin default harness |

Files and directories in `~/.vibest/plugins/` are added without an entry, before the entries. A plugin reads its options
from `context.options` and they reload live:

```ts
export default Plugin.define({
  id: "glm-only",
  effect: (context) =>
    Effect.gen(function* () {
      const { provider, model } = context.options
      yield* context.agent.hook("start.before", () => Effect.succeed({ harness: "pi", provider, model }))
    }),
})
```

`vibest.json` has one key, `plugins`. Machines are not configuration: `vibest machine add` and `vibest machine rm` record
them in the ledger (`machine.added`, `machine.removed`). Agent definitions are added by plugins with `agent.transform`;
the skills are the builtin `delegate` and `pipeline` (§4.2).

## 8. Harness adapters

A harness adapter is a `HarnessDefinition` (`packages/plugin/src/effect/harness.ts`) that a plugin adds with
`context.harness.transform`. The definition holds how this CLI is started and told things (launch side); the harness's
vibest plugin or extension, loaded at launch, brings its work back as events (integration side). `packages/plugin-harnesses`
implements Claude Code and Pi as the builtin plugins `harness-claude` and `harness-pi`, and Cursor and Antigravity (`agy`) as plugins the user adds
(the shipped `harnesses/cursor` and `harnesses/agy` folders go into `plugins` in `vibest.json`). Core and the CLI hold no
adapter: vibestd answers `vibest harness list` (each row with its `binary`) and the integration guard from the registered
definitions. A user plugin may add a harness or `update` a builtin one the same way. A harness id is a plain string: an id
the database names but no plugin provides is unavailable ("no plugin provides harness X; loaded: …"), never a decode
failure. Each CLI runs as installed on the machine, with its own login.

**The definition** (fields of `HarnessDefinition`):

| Field                                         | Meaning                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `binary`, `integration?`                | the harness id, the program to run, and the folder name of its plugin (default `id`)                                                         |
| `launchArgs`                                  | arguments from the worktree, project folder, system prompt file, provider, model, conversation id, resume, plugin folder                     |
| `ownSessionId`, `conversationOf`              | whether the CLI chooses its own conversation id, and how an event names it                                                                   |
| `systemPromptInPrompt`                        | the prompt goes in front of the first input instead of a file (herdr refuses launch arguments with newlines)                                 |
| `startup`                                     | answers startup dialogs in the pane (Claude's folder-trust menu)                                                                             |
| `interruptKey`                                | the keys that stop the agent's current work                                                                                                  |
| `inbox`, `ready`                              | how rows reach it (`poll` or `subscribe`, otherwise typed into the terminal) and whether readiness comes from its integration or the runtime |
| `models`, `checkProvider`, `checkEnvironment` | lists its models (cached 5 minutes), validates a provider, checks the home; feed `preflight` and `vibest harness list`                       |
| `subscription`                                | reads this CLI's usage windows into its Subscription                                                                                         |
| `userPrompt`, `executionEnd`, `replyField`    | decode the CLI's own events into a typed prompt, an execution end and the reply text                                                         |
| `guardAnswer`                                 | the answer to a tool-call guard in the CLI's own shape                                                                                       |

A harness listing its models reads them from the user's home, not the caller's directory (a worktree may be gone since).
With a request the listing keeps stdin open, since a server may exit at EOF before it answers, and stops at the first
output that holds a list. A model's provider null is the harness's default provider; `default` marks what it runs with no
model given, as its own settings decide.

**Integration side: plugins loaded at launch, never installed.** vibest's plugin for each harness ships with the binary
(`harnesses/<harness>`, built by `packages/cli/scripts/build-harnesses.ts`): in each release archive beside `bin/vibest`,
and in the `@vibest/cli` npm package, whose platform packages hold only the binary. `bin/vibest.cjs` hands the npm
directory to the binary as `VIBEST_HARNESSES`; without it the compiled binary looks beside its own directory
(`<root>/bin/vibest`, `<root>/harnesses`, the link resolved), which is how install.sh's install runs, without Node; a
binary run bare from the npm package then tries the `@vibest/cli` package, flat (`node_modules/@vibest/cli`) or nested.
From source there is no layout to look beside, and a harness whose plugin directory is missing is unavailable (`preflight`
says so, naming the directory). The adapter loads the plugin into each session it starts, the entry session included: Pi
`-e <dir>/extension.mjs -e <dir>/presentation.mjs`, Claude Code and Cursor `--plugin-dir <dir>`. Each of these adds to what
the harness loads; the user's own plugins, extensions and hooks keep loading beside it. Why not install into the harness's
config:

- scope: an installed plugin runs in every session of the user, not only vibest's (a fail-closed guard of a broken vibest
  would block the user's own Cursor);
- version: the plugin always matches the binary it ships with; there is no `outdated` state, update step or marketplace;
- no writes to the user's config, so no diff, backup or uninstall leftovers.

The cost: a harness started by hand does not load it, which is the intent. vibest never writes into a harness's config and
never reads its config or credential files; it asks the harness CLI. Results come only from the plugin's execution-end
report.

**Claude Code: one hooks module over HTTP.** vibest writes nothing into `~/.claude/settings.json`. The plugin
(`packages/integration/claude`) is a hooks module (`hooks/hooks.json` → `register.mjs`, no command hooks, no shell). Every
call is an HTTP request to vibestd's unix socket `<VIBEST_HOME>/vibest-http.sock`; the plugin runs no `vibest` process. Its
native listeners are `turn.complete` (each main-loop execution end, with its reason and the answer; a subagent's loop
reports nothing), `prompt.submit` (a prompt with its origin: the person's text only from origin `composer` or `bridge`, and
vibest's own delivery reported as accepted), `tool.call` (the guard, refused when nothing answers) and the inbox, which polls
vibestd every second while the session is idle. The README of the package has the protocol details. Claude's trust menu is
answered in the pane by the definition's `startup`. The project folder's permission rules are `Read(//<dir>/**)` and
`Edit(//<dir>/**)`, and `Bash` is allowed. An aborted `turn.complete` is an interrupted result only when the person pressed
Esc; vibest's own interrupt records none. The conversation id is the one Claude reports at its events (`ownSessionId`). Its
models come from the stream-json `initialize` control request and `get_settings` under `--safe-mode`, so no hooks or
plugins run. `turn.complete` carries no API error kind, so a Claude usage limit is a failed result, not a usage-limit move.

**Cursor: hook files.** The plugin (`packages/integration/cursor`) is a directory of hooks that cursor-agent loads with
`--plugin-dir`; each hook calls the vibest that started the session (`VIBEST_COMMAND`) through `vibest integration guard`,
`ready`, `prompt` and `stop` with `--harness cursor`. `sessionStart` reports readiness (the first task is typed only after
it), `beforeSubmitPrompt` and the thought and tool hooks report work, `afterAgentResponse` carries the reply as `text` and
ends the execution. The guard hook is fail-closed: a crash, timeout or missing answer refuses the call, so the guard always
answers explicitly; `allow` only lets the call go on to Cursor's own permission checks. The hooks act only for a vibest
session (`VIBEST_SESSION_ID`). A resume is one argument, `--resume=<id>`.

**Pi: one extension.** vibest loads one extension per session for inbox delivery, execution reports, the guard and the
entry session's TUI; `presentation.mjs` is a separate extension that groups tool rows in the TUI. Only the root TUI
session participates; a Pi child of a session takes no rows and reports nothing. See the
[Pi integration](../../packages/integration/pi/README.md) for adapter and TUI internals.

**Nested conversations are filtered**: events carrying `agent_id` (the CLI's own subagents), and Cursor events whose
`CURSOR_CONVERSATION_ID` differs from the conversation's, are ignored.

## 9. Harness choice

Which harness a session runs on is decided in two steps. First core fills what the request left out
(`packages/core/src/session/spawn.ts`): a `vibest run` without a harness takes the harness, provider and model of its
calling session (the parent); a named harness replaces all three, and `--provider` or `--model` alone overrides only that
field. The entry session started by bare `vibest` without `--harness` takes the harness the project's entry session last
used (`packages/core/src/session/entry.ts`). Then the `agent.start.before` chain (§7) runs, every plugin in order, each
able to keep or overwrite what came before; the builtin `harness-default` picks `claude` when nothing has chosen and
claude is available. A start that still has no harness fails with `NoHarnessChosen` ("no harness to inherit: name one, for
example `vibest run claude -- <prompt>`"), and a first bare `vibest` fails asking for `--harness`. vibestd validates the
final harness (a plugin provides it, its plugin directory is there, its model list reads, the model is offered) and refuses
a start that never settled on one.

A usage limit is the same decision in reverse, on `agent.fail`: the execution that failed stays the execution that
finishes, and the session restarts (same id, same worktree, same task: the open execution's input, else the text the launch
was about to send, else the trailing delivered batch) on the harness the chain returns as its move. Before each candidate
starts, the move runs the `agent.start.before` chain with the move's harness, provider and model and the session's real
attempts prefilled: a refusal skips that candidate (recorded as a `refused` try), and what the chain decides, including a
rewritten harness or prompt, is what gets started, so a start policy plugin governs a moved session exactly like a first
start. vibest itself does not move: when no callback returns a move the execution fails, naming that harness and each
exhausted limit with its reset time, and no other harness starts. The pairs that already hit a limit are remembered per
(harness, provider) in `process.end` facts with reason `limited`, so they survive moves and a vibestd restart. Within one
execution vibest never moves to a pair that hit a limit in it, whatever that login's usage reading says now: an execution
that hit limits on every login it may use fails instead of cycling, and a later execution may use such a login again once
its own usage row, refreshed after the limit, says it is free. A preflight miss, or a start or prompt that fails, is not a
limit; the next move may use that harness again. A login already limited before start is left to `agent.start.before`:
without a plugin that routes by quota, the session starts and fails its execution the usual way when the limit hits.

How the move runs (`packages/core/src/session/move.ts`, under the session's lock): a choice the chains already ruled out
(an unknown harness, a login limited in this execution, a harness this move skipped) ends the move, since asking the same
plugins again cannot change the answer. The move stays on the session's own runtime and machine. It ends the old process
before the next starts: a refused SIGTERM (sent to the harness pid alone, never its group, which is the terminal's shell)
or a failed close keeps the session where it was, so no second process ever runs. With a runtime that can `run` in a
terminal the next harness starts in the session's own terminal; otherwise the terminal closes and a new one opens. `open`
failing with code `failed` is the start dying inside the terminal (its own limit, a crash) and skips to the next candidate;
any other code is a placement refusal and ends the move. A prompt the runtime took whose execution never started counts as
a failed prompt: the execution stays working and the next harness prompts it again.

A move does not carry the model named for the old harness, which the new one would not list: the move starts on the new
harness's default.

## 10. Ports

| Port                                                                   | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Implementation                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Runtime** (`@vibest/plugin` `RuntimeDefinition`, runtime-port.md §3) | one `RuntimeDefinition` a plugin adds (`ctx.runtime.transform((editor) => editor.add(definition))`): required `id`, `status()`, `events` and, on terminals, `open`, `send`, `read`, `process`, `close`; optional `name`, `caller`, `state`, `session`, `present`, `seen`, `attach`, `link`, `locate`, `doctor`. One error type `RuntimeError { code }`; a runtime manages only the terminals of its own machine. Core uses only the required members and checks whether an optional one exists, never which runtime it is | `runtime-herdr`, `runtime-herdr-core` |
| **Harness**                                                            | §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `plugin-harnesses` (claude and pi)    |
| herdr connection                                                       | one client per herdr session (the current session inside herdr, a named headless session started by vibest outside it); the protocol is pinned in `effect-herdr-sdk` and checked by `ping` on every connect                                                                                                                                                                                                                                                                                                               | `effect-herdr-sdk`, `runtime-herdr`   |
| **MachineTransport**                                                   | reach another machine's vibestd over an ssh pipe (§12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/platform-bun/src/bun.ts`    |

## 11. Herdr surface

vibest uses herdr through its own extension points (herdr 0.9.5; [herdr-surface.md](herdr-surface.md)).

- **herdr plugin** in `packages/cli/herdr-plugin` (`herdr-plugin.toml`). Every entrypoint runs `vibest herdr <verb>`
  and reads `HERDR_PLUGIN_CONTEXT_JSON`; the plugin holds no state. vibest does not link it; the user does
  (`herdr plugin link`), and binds keys in their own herdr config.
  - Actions: `open-entry` (open or focus the entry session of the focused pane's Project), `run` (read a prompt and
    start a session), `stop`, `runs` (list the Project's live sessions), `subscriptions` (usage per harness),
    `palette` (a menu of these actions), and a startup hook that asks vibestd to republish pane metadata, since herdr
    does not restore it.
- **Presenter** (`present` of the `runtime-herdr` runtime) projects vibestd's state onto herdr:
  - pane metadata (`pane.report_metadata`, source `vibest`): `display_agent` (`<agent> · <harness>`), `title`,
    `state_labels` (`blocked` → `waiting for you`), tokens `definition` and `session`;
  - workspace metadata (`workspace.report_metadata`): tokens `project` and `agents` (the live session count).
- **Machines** map to herdr saved machines; sessions on another machine show in herdr's own session list (§12).

## 12. Multiple machines

Designed in [`multi-machine.md`](multi-machine.md) and [`runtime-port.md`](runtime-port.md). Every machine runs its
own vibestd; vibestds reach each other over one long-lived ssh pipe (`vibest connect` on the far side), outward only.
`vibest machine add` records a machine and the far vibestd records this one as a peer. `vibest run --machine <name>`
starts a session in that machine's checkout of this repository at this HEAD (the commit must be pushed); its address is
`<machine>/<id>`, and `send`, `result`, `peek`, `ls`, `interrupt` and `archive` reach it. A session reaches on another
machine only the sessions it started there. A machine that is not connected shows as such in `vibest ls`, and messages
sent meanwhile arrive once the connection is back.

## 13. Surfaces and protocol

```
vibest [--new] [--harness <h>] [--provider <p>] [--model <m>] [--runtime <r>] [--session <s>] [--headless]
                                            in a project directory: open its entry session here (create or resume it)
vibest run [<harness>] <prompt> [--agent <definition>] [--title …] [--provider …] [--model …] [--env K=V]
           [--share <session>] [--archive-on-idle] [--runtime …] [--machine …]
                                            a session starts another session; refused with no calling session
vibest send <id> <message>                  queue; delivered once the session is idle, never interrupts
vibest interrupt <id>                       stop its running execution, keep the session
vibest archive <id> [--keep-worktree]       end the session, release its pane and worktree
vibest ls [--all]                           sessions: task, status, latest result
vibest result <id> · peek <id> [-n <lines>] · events [--session <id> [--after <seq>]] [--follow]
vibest project create <directory> --from <repository>… · add [<directory>] · info · search <query>
vibest daemon [--foreground] · daemon restart · status · update · doctor · plugins · subscriptions
vibest models [<harness>] · harness list | models <harness>
vibest machine add | ls | rm · connect
vibest integration guard | prompt | stop | ready --harness <h>     internal: what the harness plugins call
```

**Conventions for agents**: queries print one JSON document on stdout; errors print `<Tag>: <message>` on stderr; exit
codes 0, 1 failure, 2 usage, 130 interrupted; text is a literal argument or `-` for stdin, empty text is `EmptyInput`,
`@file` is not expanded.

**Protocol** (`packages/protocol`): effect/rpc over the unix socket, one JSON-RPC 2.0 object per line. Every method but
`Ping` needs the `vibest-protocol` header; each command Pings once first and stops with `IncompatibleDaemon` on a
mismatch; the package version is informational. `PROTOCOL` is the only version, for RPC and the HTTP API alike (HTTP
paths carry none); old versions are not served. An additive feature does not bump it: Ping's `capabilities` gets a
boolean flag, and a client uses the feature only when the flag is there. Flags (`CAPABILITIES`): `http`, `handoff`,
`requests` (`Send` and `Spawn` take an optional `request` id: `vibest send` and `vibest run` make one per invocation and
send a call whose connection dropped once more with it, and vibestd answers a repeat as the first; only to a vibestd
that has the flag, and never after an answer, a refusal included), `watch`, `events`, `projects`, `spawnRuntime`. A
mismatch is answered with what vibestd speaks (protocol, package version), a message and the command to run
(`protocolMismatch`, the command in `MISMATCH_ACTION`): both ways it is `vibest update`, which restarts the agents on the
new version. RPC fails with `ProtocolRejected`, HTTP answers 409.

**Callers.** Scoped methods need the `vibest-caller` header: `cli` (the user, with the project directory), `session`
(with `vibest-session-id`, which must name a stored session of the stated project) or `peer` (another vibestd,
multi-machine.md). A missing or contradictory header is `InvalidCaller`, never the user. The `ACCESS` table in
`packages/protocol/src/rpc.ts` lists every method, checked at compile time:

| Access  | Who may call                                       | Methods                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| open    | anyone with the protocol header                    | `Ping`, `Plugins`, `Harnesses.List`, `Integration.Guard`, `Runtimes.Doctor`, `Subscriptions`, `Republish`, `ExecutionEnd`, `Prompt`                                                                                                         |
| session | a session                                          | `Inbox.Subscribe`, `Inbox.Take`                                                                                                                                                                                                             |
| self    | only that session, from its own terminal           | `Session.Ready`                                                                                                                                                                                                                             |
| agent   | the user or a session of the project               | `Spawn` (a session only), `List`, `Get`, `Project.RunningEntry`, `Project.Info`, `Project.Search`                                                                                                                                           |
| owner   | the user, or a session for the sessions it started | `Send` (a session may also answer its creator), `Interrupt`, `Peek`, `Remove`                                                                                                                                                               |
| cli     | the user only                                      | `Launch`, `Watch`, `Events`, `Session.Seen`, `Project.Open`/`EntryPlace`/`EntrySession`/`StartEntry`/`FocusEntry`/`StopEntry`/`Create`, `Daemon.Stop`, `Daemon.Handoff`, `Agents.Outdated`, `Agents.Restart`, `Machine.Add`/`List`/`Remove` |
| peer    | another vibestd that said `Peer.Hello`             | `Peer.Hello`, `Peer.Spawn`, `Peer.Outbox`, `Peer.Ack`, and the forwarded `Ping`, `Harnesses.List`, `List`, `Get`, `Send`, `Interrupt`, `Peek`, `Remove`                                                                                     |

Socket mode 0600 is the authentication; roles prevent mistakes, not attackers.

**RPC methods** (`packages/protocol/src/rpc.ts`). Three middlewares: `ProtocolGate` (every method but `Ping`),
`CallerGate` on scoped methods (resolves the caller for that request only, from its headers and the stored row), and
`Admission` on methods that change something (see [drain admission](daemon.md#admission-while-draining)). Open methods
take no caller: `Harnesses.List` (each harness with `problem`, null when vibestd can start it, else why not, and the
models it lists; the same preflight `Project.StartEntry` and `Spawn` route by; `vibest models` and `vibest harness list`
print it), `Runtimes.Doctor`, `Subscriptions`, `Republish` (put terminal labels back after the runtime started or
restarted; answers how many), and the hooks' `ExecutionEnd` and `Prompt` (verbatim harness JSON read with the adapter's
`executionEnd` / `userPrompt`; unknown ids, another harness than the session's, and events the adapter ignores change
nothing; a prompt from the entry session or from vibest's own delivery is ignored). Of the rest:

- `Spawn`: `harness` is optional when a routing plugin picks it; `agent` is a registered definition id (`general` by
  default); `machine` defaults to `local`; `share` shares that session's worktree in a split of its pane; `archive`
  archives the session once it is idle after a completed execution. The caller must be a session: it becomes the new
  session's parent; no calling session is `NoCallingSession`.
- `Send` queues and returns; vibestd delivers once the session is idle. A session reaches only its creator and the
  sessions it started; when its creator has ended, the nearest living session above it. Failures reach the sender's
  nearest living creator as notices. An `id` is a session id or a unique prefix of at least 8 characters, and the answer
  names the full id.
- `Remove`, `Interrupt` and `Peek` need the user or the nearest living creator of the target. `Get` never waits. `Peek`
  reads the last `lines` (default 30) of the terminal when asked: screen text is never pushed to an agent, so a session
  looks there itself when an execution ended without a reply. `Inbox.Subscribe` streams the session's inbox batches
  (the Pi extension) instead of the runtime's prompt; `Inbox.Take` is the same pull for a harness that polls.
- `SessionInfo.task` is the first row delivered from the user or the parent (`List` cuts it to 500 characters);
  `latest.summary` is the first trimmed line of the execution's `reply`.
- `Launch` opens `vibest`'s entry session outside the repository's worktree: a tab there, or a new workspace at its
  root, whose shell runs argv. `Project.Open` finds or makes the project of the directory (`move` answers a
  `ProjectMoved`). `Project.EntryPlace` says where the entry session goes (this terminal, or a launch).
  `Project.StartEntry` picks the entry session's harness, provider, model and runtime and writes nothing.
  `Project.EntrySession` then upserts the entry session row at its terminal and returns the harness command the CLI
  execs, with the caller's PID. `Project.RunningEntry` finds the entry session in another pane; `Project.StopEntry` sends
  SIGTERM to its recorded PID only, keeps its terminal, and answers `stopped`, `running` (nothing changed), `moved` (the
  row is no longer there) or `unsupported` (with the reason); `Project.FocusEntry` focuses it.
- `Watch` and `Session.Seen` (user only, `watch` and `projects` capabilities) serve a client that shows the sessions.
  A watched session carries `finished` (the runtime's count of finished executions, null without `seen`) and status
  `done` when it is idle and its finished count is past the runtime's seen mark; a project carries `activity`, the first
  of blocked, done, working its live sessions show, else idle (herdr's order: a finished agent waiting for the user
  outranks a busy one). `Session.Seen({id, finished})` raises that mark to `finished` only when it rises and no further
  than the runtime's count; anything else writes nothing.
- `Events({ session?, after?, follow? })` (user only, `events` capability, this machine only, never forwarded to a peer)
  streams facts as `{ aggregate, seq, at, type, data }`: one session's by its `seq` (an ended session too; an unknown id
  fails with `NoSuchSession`), or the whole log in commit order with each aggregate's `seq` rising. It reads the log by
  cursor in pages (`Bus.log`) and uses the Bus subscription only to wake, so no fact is skipped or repeated whatever
  order the Bus published commits in. A read without `follow` stops at the latest `seq` (or log position) captured when
  it starts; `follow` continues past it and keeps the stream open for facts committed later. `after` (valid only with
  `session`) starts after that `seq` with no gap or repeat; the whole log has no resume cursor, and the log position
  never leaves vibestd.
- `Daemon.Stop` (user only, naming the instance from Ping): accepted, not exited; a client sends it once and watches
  Ping. `Daemon.Handoff` (`handoff` capability) checks that `command` opens the database, drains as `Daemon.Stop` does,
  starts `command daemon --foreground --import`, then hands over its sockets and lock; a failure before that leaves it
  serving. `spawnDaemon`'s `env` reaches only the new vibestd's environment.
- `Session.Ready` is the integration saying the harness takes input, with the harness's own `pid` (or, with
  `conversation`, the conversation id a harness made for the session, the last report wins); vibestd hands over a first
  or restarted execution only after it, and answers with the session's current process id, which the integration sends
  with its later reports. A Ready is taken only from the current process: one that names an earlier process counts only
  when that process ran in the same terminal and the pid is new (a harness an in-place restart or move ran with the
  terminal's first environment); a pid an earlier process reported is a late report from it and changes nothing.
- `Agents.Outdated` lists live sessions whose integration is not this vibestd's (`blocked`: why one cannot restart in
  place). `Agents.Restart` returns at once and, once process `after` exited, restarts them in place: sessions started by
  a session first (at most 4 at a time), then entry sessions; SIGTERM to the harness alone, then the runtime runs it
  again on the same conversation. An interrupted execution gets a continue execution, a working entry session a continue
  notice naming the outcomes, which also go to vibestd.log.
- `Machine.*` and `Peer.*` connect vibestds over ssh (multi-machine.md).

**Client** (`packages/client`). One short connection per command; the Ping preflight is the only Ping, and the call
itself carries its headers. The RPC protocol layer is built into the caller's scope: `Effect.provide` would close the
socket as soon as the client is made. Its keep-alive ping timeout is a day, because the JSON-RPC serialization does not
encode keep-alive pings and the default 5 s timeout would cut every longer call (an `Inbox.Subscribe` stream); a closed
unix socket still fails the read at once. An incompatible vibestd that `vibest daemon restart` cannot replace is stopped
by the user: vibest prints the PID check and `kill -TERM`, and never signals it.

**Daemon:** only the user starts vibestd; replacement drains daemon operations, not running agents.
See [daemon lifecycle and replacement](daemon.md#lifecycle-and-replacement).

**Daemon start:** a start lock serializes startup and handoff; a successor never removes a live daemon's socket.
See [daemon start](daemon.md#daemon-start).

**Admission while draining:** new changes are refused while already-started work can settle.
See [drain admission](daemon.md#admission-while-draining).

**Session requests:** each request is checked against its session and project; entry session starts are serialized per
project. See [session requests](daemon.md#session-requests).

**HTTP API** (`vibest-http.sock`, `packages/server/src/http.ts`): what an integration that can only make HTTP requests
calls (the Claude plugin's `$.http.fetch`). Every route is `POST /<route>` with a JSON body, answered at once; the
caller is named by the shared session headers.

| Route                            | Answer                                  | What                                                                      |
| -------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `/inbox/take`                    | `{ execution, ids, line, text }` or 204 | the session's next batch when idle and no execution is open (Inbox.take)  |
| `/session/ready`                 | `{ process? }` or 204                   | the harness takes input now; the harness's own pid, as `Session.Ready`    |
| `/hooks/<harness>/execution-end` | 204                                     | the adapter's `executionEnd`, kept as the execution's reply; a settlement |
| `/hooks/<harness>/prompt`        | 204                                     | the adapter's `userPrompt`: the execution starts; a settlement            |
| `/hooks/<harness>/guard`         | `{ deny? }`                             | Guard.check with the session's own agent and project folder               |

Errors are `{ error }`: 409 another protocol (with `ProtocolMismatch`), 404 no such session or route, 403 another
project, another harness than the session's, or a poll from a harness that does not pull, 503 vibestd is stopping.
Routes match on the path alone, whether the server reports it with or without scheme and host. The guard reads the
session's project folder as its terminal's `VIBEST_PROJECT_DIR`, which vibestd itself has none of. `/session/ready`, sent
once at the harness's start, is the same fact as `Session.Ready`; vibestd waits for it before handing the harness an
execution.

**Distribution:** install.sh and npm ship the same compiled binary; updates use the original install method.
Installs stay outside the data home. See [distribution](distribution.md) for packaging, launchers and update checks.

## 14. Home layout

```
~/.vibest/                   (VIBEST_HOME overrides)
  vibest.json                the plugin list (§7), read only
  plugins/                   plugin files and directories (§7), read only
  vibest.db                  the event log and read model (with its -wal and -shm files)
  identity.json              this machine's id, name and machine_id; created or rewritten at every vibestd start
  vibest.sock  vibest-http.sock   vibestd's RPC socket, and the HTTP socket the Claude plugin reports to
  vibestd.pid  vibestd.log   vibestd's start lock and record, and its log (trimmed at startup; see daemon.md)
  projects/<project id>/     the project folder: preferences.md, docs/, memories/, artifacts/
  worktrees/<repository>/<name>/   a session's worktrees (`.worktreeinclude` copied)
```

The vibest install itself is not here: install.sh puts it in `~/.local` (see [distribution](distribution.md)), npm in
its prefix.

The system prompt each harness gets is not kept here. It is generated again from the session's row and the project's
files on every harness start (new, resume, restart, move to another harness) and written to
`$TMPDIR/vibest/<session id>/system-prompt.md`; without TMPDIR, to `/tmp/vibest-<uid>/<session id>/`, a directory that
must be the user's own with mode 0700 and no symlink, checked with one `lstat` that does not follow a link, so nothing
can be swapped between two checks. Archive removes the session's directory once its processes have exited (they may
still read the prompt or report an execution end); the system cleans the rest.

`vibest project create` (`core/project/create.ts`) checks everything before it writes anything, and on failure or
interruption removes only what it created. Each copy is independent (`--no-hardlinks`, no alternates), on the source's
branch, with the source's origin, `origin/*` refs and upstream; the local path it was cloned from is not kept as a
remote, and uncommitted changes are not copied. A directory is a multi-repository project when it is not itself in a
git checkout and its direct children are main checkouts; a directory of linked worktrees belongs to the project of the
shared parent of those main checkouts (one level).

A session's worktree (`core/worktree.ts`, `core/git.ts`) is one detached worktree per repository (`git worktree add
--detach`); no branch is created. A worktree is recorded before `git worktree add`, so a failure or interrupt during the
add still removes what git left. `.worktreeinclude` (gitignore syntax, the Claude Code convention) copies only paths git
ignores both in the main checkout and in the worktree (a rule only the main checkout has would leave the copy
untracked); git does the matching, and a nested repository is never included. A symlink is recreated as the same link,
never followed; a path that exists in the worktree or lies under a link there is left alone (git check-ignore fails on a
path beyond a symlink). Nothing is recorded in git.

## Appendix A. Patterns borrowed from OpenCode

Sources are in `anomalyco/opencode`, `packages/core/src`. These are sources to read when implementing, not vocabulary.

| vibest                           | Pattern                                                                         | Source                                 |
| -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| Service graph and scopes (§5)    | typed dependency graph over Layers, replacement-based configuration             | `effect/layer-node.ts`                 |
| Plugin API (§7)                  | `Plugin.define` with `{ id, effect \| setup }`, registration through `ctx`      | `packages/plugin/src/effect/plugin.ts` |
| Catalog state (§7)               | synchronous editors replayed in registration order, batched change notification | `plugin/registry.ts`                   |
| Hook dispatch (§7)               | sequential, single mutable event, decision fields (transform, refuse, decision) | `plugin/hooks.ts`                      |
| Plugin supervisor and order (§7) | `(id, revision)`, reactivation, builtin / user / configuration order            | `plugin/supervisor.ts`                 |
| Global configuration (§7)        | global directory only (vibest has no project tier)                              | `config/`                              |

Where vibest differs: protocol, persistence, delivery, and the daemon are vibest's own; there is no coding-agent
domain; harness adapters sit on top of an external runtime.
