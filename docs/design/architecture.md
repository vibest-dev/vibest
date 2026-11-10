# vibest Architecture (draft 9)

Status: draft for review. Nothing here is implemented.

vibest is a **product for one person**, shaped like Claude Projects or Cursor projects: a Project holds your
instructions, knowledge, memory, and conversations, and inside it you chat with one **main Agent** that hands work
to **subagents**, the CLI agents installed on your machines (Claude Code, Cursor, Pi, …), running in terminal panes
you can watch and step into (herdr first; the runtime is a port, D14). It is not a workflow framework and not a platform for composing agent engines.

The daily experience, which every part of this document serves:

1. `cd shop && vibest` opens the Project's main Agent and resumes its conversation (the Project is created on
   first use); `vibest --new` starts a new conversation in the same Project, with the same knowledge.
2. You say what you want. The main Agent decides how to split it, runs subagents with `vibest run`, and does not
   block: you keep talking while they work in panes beside it, grouped under the Project.
3. Each subagent's result comes back into the main conversation by itself; the main Agent checks it and reports.
4. You can step into any subagent's pane, also after it finished, and keep talking to it. That exchange goes
   back to the main Agent as information, so it knows what you did.
5. The main Agent always knows every subagent's task, status, and latest result (`vibest ls`), also after
   compaction or a restart.
6. When a job needs a fixed flow (plan → implement → review until both sides agree → pull request), the main
   Agent runs it with a skill, driving several subagents, with you able to step in at every point.

This shape is the default orchestration mode. The plan makes it one of several: other modes become configurations of the same engine (planned, §1, D13).

- It is not a coding agent: it does not own conversations, tools, or models.
- **The agent runtime is a port** (D14): panes, processes, starting an agent, typing into it, reading its screen,
  machines. herdr is the first implementation, not a dependency of the core.
- **Harness adapters** are built in and hold every per-CLI difference (§8). Their integration side installs a
  vibest plugin or hook into each CLI, so every step of the CLI agent's work comes back to vibest as an event,
  and messages go into the agent natively. The rest of vibest is harness-neutral.
- vibest starts inside a Project directory. Each Project always has one **main Agent** the user chats with;
  every subagent is started under it (by that agent or by the user) with `vibest run`.

Reference implementations:

- **OpenCode V2** (`anomalyco/opencode` at `f0944f0`, 2026-10-30): vibest borrows its code architecture, Effect
  patterns, and plugin API, and its split of **domain in the core, implementation and rules in plugins**. It
  does not borrow the coding-agent domain or the vocabulary; Appendix A maps each borrowed pattern to its source.
- **omac** (`iamdin/pi-orchestrator`): the predecessor. Where its implementation is good, vibest copies the code
  and refactors it into vibest's model (D12, §15): protocol, daemon, delivery, cleanup, integrations, guard.
- The orchestrator survey in `~/ObsidianVault/CLI-Agent-Orchestration-Research/` (§1).

## 0. Fixed decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The runtime (herdr first) runs panes and processes. What happens inside a CLI agent reaches vibest first through harness integrations (hooks, plugins, extensions); the runtime's state detection and screen reading are the fallback. Per-CLI differences live only in harness adapters.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D2  | The core defines the domain (schema contracts, lifecycles, execution, scheduling framework). Implementations and rules are plugins, builtin by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D3  | The execution unit is the **Run**: one or more subagents working on one input. The core defines no orchestration patterns and no roles. Every Run is controlled by the main Agent (or the user) that started it. A flow over several subagents is a skill the main Agent follows; there is no workflow engine or program controller. Plugins observe, refuse, transform, schedule, and enforce rules (such as "a writing subagent is done only when the tests pass"); they never start or steer Runs.                                                                                                                                                                                                     |
| D4  | `vibest` runs inside a Project directory and opens that Project's main Agent; there is always exactly one, with one active conversation and earlier ones kept (`vibest --new`). There is no separate `launch` command: the main Agent starts through the same path as every Agent, placed in the current terminal. `vibest run` starts subagents, and only the main Agent (or the user) can run it: subagents never start Agents, so there is no nesting. Every result, and every exchange the user has directly with a subagent, returns to the main Agent. Status: this describes today and the default mode; D13 and §1.1 plan an optional entry session, nested leads and routing as data.            |
| D5  | Plugins follow OpenCode V2 exactly, Effect only (no Promise edition).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D6  | Products are composed per host from shared packages; hosts are fully isolated (no shared daemon, database, or Runs). The Herdr TUI product comes first; the herdr-core desktop application comes after the base capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D7  | Machine and multi-repository Project dimensions exist from the first commit; one machine and one repository are special cases. Several repositories are composed by copying them into one directory, never by symlinks (Node and other toolchains break on symlinked folders).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D8  | In scope now: delegation (main Agent and subagents); the `pipeline` skill (plan → implement → review → pull request); multi-machine scheduling. Other multi-agent flows (committee, racing, advisor, …) are added later as skills, by us or by the user, without core changes. Out of scope: DynamicWorkflow and any workflow engine, work-item intake, several accounts per CLI (each CLI's own login is its one Subscription for now).                                                                                                                                                                                                                                                                  |
| D9  | Names are spelled out (`repository`, never `repo`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D10 | vibest keeps a **Subscription** for every supported harness on every machine, with its usage limits, and hands the current set to plugins in each Run's context. Choosing a harness, waiting, or switching is plugin scheduling. Usage limits come only from official or CLI-provided sources, so a harness that offers none keeps an empty limits list and that is fine; a Subscription is per (harness, provider, machine), provider empty for a single-login harness (Claude Code, Cursor) and set for Pi; vibest does not read a harness token or call a usage API, so a harness that offers no limits keeps an empty list (unknown, not full). Any vibest plugin may report a Subscription's limits. |
| D11 | Information comes through the best channel each CLI offers: hooks forward events and results where a CLI has them; an agent's own `vibest report` is for explicit or structured results; reading the screen is last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D12 | Where omac's implementation is good, vibest copies its code and tests and refactors them (session → Agent and Run, inbox row → Message, plugin hooks → §7 kinds) instead of designing again. §15 lists every part.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D13 | The engine knows one kind of session, described by an agent definition. Routing, permissions and whether a session may spawn are data and plugin policy, never branches in the code. The coordinator mode (one main Agent and its subagents) is the configuration of the default plugin (§1.1). Status: decided; today the code still has the coordinator and its subagents as two cases, and the planned parts of §1 replace them.                                                                                                                                                                                                                                                                       |
| D14 | vibest is not bound to herdr. `schema`, `core`, `server`, `protocol`, `client`, the harness adapters, and the integrations never import herdr or name its types; they use the Runtime port (§10) and vibest's own types (Agent `status`, `runtime { kind, address }`). Everything herdr-specific (`effect-herdr-sdk`, `runtime-herdr`, the herdr plugin, the presenter) lives in herdr packages and the herdr product. Runtimes are plugins registering the `Runtime` API (`runtime-port.md`, `plugin/src/runtime.ts`): herdr, rex and tern are builtin; another product is a new plugin, not a core change.                                                                                              |

## 1. A multi-CLI agent engine

vibest is an engine that runs many CLI agents (Claude Code, Cursor, Pi, …) side by side, in terminals you can
watch and step into. How those agents work together is an **orchestration mode**, and a mode is configuration:
agent definitions plus plugins, never a branch in the core. The daily experience above (one main Agent handing
work to subagents) is the default mode, `coordinator`, which a default plugin provides (§1.1).

The survey groups orchestrators by the unit above a single agent. All of them need only "start an agent, prompt
it, see it go idle, read its result, message it"; they differ in that upper unit and in who decides the next
step. vibest gives every type the same engine:

| Type                      | Examples                                                                                | Unit above the agent | In vibest                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| A. Direct launch          | Paseo, hcom, DMux, Autonomous Harness                                                   | none                 | the user runs `vibest run` without an entry session; results come to the user (§1.1)      |
| B. Main Agent with a team | CAO, OpenRig, Shogun, oh-my-claudecode, ClawTeam, Squad, Paradev MCP, WSP               | a team               | **the default mode** (`coordinator`), nested leads included                               |
| C. Work-item driven       | Gas Town, Cyrus, Machinist, Emdash, Orchestrator.inc, Kandev, Cezar                     | issue or card        | out of scope: work-item intake is a plugin or an outside client                           |
| D. Workflow / pipeline    | CAO workflows, Prowl, herdr-orch, obra, Fusion, Raven, Cotal Lang, pi-dynamic-workflows | workflow run         | a skill, or an `agent.result` plugin that hands one stage's output to the next; no engine |
| E. Message mesh           | hcom, Agmsg, Cotal, Block Buzz, herdr-msg, Concord                                      | channel              | peers: sessions that `send` to each other; reply routing keeps results from looping       |
| F. Racing / best-of-N     | Orca, Uzi, Pragma, Claudexor                                                            | attempt group        | fan-out: one parent spawns N sessions and compares; gathering is a skill or a plugin      |

**What the engine knows.** Status: the coordinator mode runs today with a fixed main Agent and one level of
subagents. Everything else in this list is planned; each item says what runs today.

- **One kind of session**, described by an **agent definition** (planned): `{ name, rules, tools (inspect | full),
  skills, can { spawn, message (report-only | children | project) }, entry? }`, registered by plugins with
  `context.agent.define`. What a caller may do comes from its definition, not from the database: Spawn needs
  `can.spawn`; Send's recipient must be inside `can.message`; Interrupt, Remove and Peek need the user or an
  ancestor of the target (along `parent_session_id`); Report is a message to the caller's reply target; the
  guard reads `tools`. Today the coordinator and its subagents are two cases in the server and the guard.
- **An addressable inbox per session** (planned): every row has a recipient (a session, or the **user**) and a
  sender (a session, or the user). One delivery path, locked per recipient, for main agents and subagents alike:
  natively when the harness integration polls or subscribes, typed into the terminal otherwise. A row for the user
  is kept and read with `vibest inbox`. Today a main agent is never typed into: only a harness that polls (Claude)
  or subscribes (Pi) can be one, and a subagent-only harness (Cursor) has no inbox mode. Subagents are typed into,
  and a row with no session to go to is dropped.
- **Reply routing is data** (planned), in one function, `replyTo(turn)`, evaluated when a turn ends:
  1. The `task` and `send` rows the turn consumed whose sender is a session: the result goes to those senders,
     each once.
  2. Otherwise the session's `report_to`, written at spawn and never changed.
  3. Otherwise, when a `task` or `send` row from the user opened the turn: the user (a row, not dropped).
  4. A turn woken by a result or a notice, or opened by text the user typed into its terminal, goes to the
     session's `report_to` when it has one, and produces no result row when it has none. So a main agent (no
     `report_to`) behaves as today, peers the user started (no `report_to`) cannot answer results with results,
     and a nested lead (`report_to` its main agent) still hands its gathered answer up.

  A recipient that has ended falls back to the project's entry session (while it runs and is not the session
  itself), then to the user. Last, the `agent.result` hook (`{ sessionId, turnId, status, output, recipients }`)
  may rewrite the recipients: forward, merge, or clear them. Notices go through `agent.notice` (`{ about, kind:
  blocked | not_started | undelivered | archived, text, recipients }`); by default to `report_to`, then the
  entry session, then the user. Today a result goes to the parent, else to the project's main agent.

- **Provenance by parent.** `parent_session_id` records who spawned whom. It decides management rights (ancestors)
  and where a new terminal opens (beside its spawner), never routing. Today the parent also decides routing: a
  result goes to the parent, else to the main agent.
- **An optional entry session** (`project.entry_session_id`, `main_session_id` before the schema baseline): the session a
  bare `vibest` reopens, and the fallback when a recipient has ended. It is not identity. "One main agent per
  project at a time" is the rule for moving this pointer, with today's y confirmation. A project may have none.
- **Harnesses registered by plugins**: a plugin adds a `HarnessDefinition` with
  `context.harness.transform((editor) => editor.add(definition))`, like a runtime with `context.runtime.transform`.
  The three builtin harnesses are the plugins `harness-pi`, `harness-claude` and `harness-cursor` in
  `packages/plugin-harnesses`, loaded first; their integration files stay in `packages/integration/*`. A harness id is
  a plain string: a harness the database names but no plugin provides is unavailable ("no plugin provides harness
  X; loaded: …"), never a decode failure.
- **One neutral integration event contract** (planned): every integration sends the same events over vibestd's
  HTTP socket, `POST /events` with `ready`, `conversation`, `turn.start` (origin typed or inbox, and the inbox
  row ids the turn consumed), `turn.end` (outcome completed, failed or interrupted; text; failure `{ kind: limited
  | auth | other, message }`) and `blocked`; `POST /guard` with a neutral `ToolCall { kind, name, command?,
  paths }`. vibestd parses no harness's own payload; a CLI with only shell hooks (Cursor) decodes in its own
  process through `vibest integration event <hook>`. Today each harness reaches vibestd its own way (Claude over
  HTTP, Pi and Cursor over RPC `TurnEnd` and `Prompt`) and the adapter decodes the raw event in vibestd.

### 1.1 Orchestration

The coordinator mode is the configuration of the default plugin `@vibest/plugin-coordinator` (planned as its own
package; today the same behaviour is built into core and the builtin skills): a `main` definition (spawn,
message children, inspect tools, entry), a `worker` definition, the `delegate` and `pipeline` skills,
archive-on-completion, and the notice policy. In `agent.start.before` it sets `reportTo` to the entry session
when the user runs `vibest run` in a project that has one.

Every other mode is configuration of the same engine (planned):

| Mode                              | Configuration                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator and subagents (today) | the default plugin. A subagent's `report_to` is the session that spawned it; a run the user starts reports to the entry session. The main agent's turns are typed or woken by results, so by rule 4 they produce no result: as today                                                                       |
| Peers                             | two `vibest run --agent peer` (`message: project`, no `report_to`: only when the project has no entry session or the run overrides it, since the default plugin sets `report_to` to the entry). A runs `vibest send B`; B's turn answers A (rule 1); A's turn woken by that result answers no one (rule 4) |
| Pipeline                          | `vibest run --report-to <B>`; or an `agent.result` plugin that queues A's output as a `task` for the next stage (or spawns it) and clears the original recipients                                                                                                                                          |
| Fan-out and gather                | a parent spawns N sessions and every result comes back to it (the default). Waiting for all N is a skill or a plugin; the engine does not gather                                                                                                                                                           |
| Reviewer loop                     | the implementer's `report_to` is the reviewer; the reviewer sends changes with `send`, and the implementer's result goes back to it by rule 1. A skill or a plugin counts the rounds                                                                                                                       |
| A person with a few agents        | no entry session; the user runs `vibest run` directly. Results and notices are rows for the user, read with `vibest inbox` and the unread count in `ls`                                                                                                                                                    |
| Nested coordinator                | a `lead` definition (spawn, message children). main spawns a lead, the lead spawns workers; workers answer the lead, the lead answers main (its `report_to`). Management rights follow ancestry                                                                                                            |

**Left to plugins and skills**, never the engine: gathering several results, loop and round limits, conditional
routing, teams and shared task lists, and handoff between agents. The engine only guarantees that a turn woken by a
result or a notice produces a result only for a session with a `report_to`, so sessions without one (peers the user
started, a main agent) cannot answer results with results (rule 4), and that every row has one recipient.

## 2. Layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Product (packages/cli): product identity + runtime-herdr                  │
│                         + herdr plugin + presenter + CLI                   │
├───────────────────────────────────────────────────────────────────────────┤
│ Builtin plugins: harness adapters and integrations · workspace types       │
│   scheduling · guard · knowledge · skills (delegate, pipeline) · check     │
├───────────────────────────────────────────────────────────────────────────┤
│ Plugin API (OpenCode V2, Effect only)                                      │
├───────────────────────────────────────────────────────────────────────────┤
│ Core: schema contracts · lifecycles · execution · scheduling framework     │
│       durable events · plugin host · ports                                 │
├───────────────────────────────────────────────────────────────────────────┤
│ herdr (agent runtime)                                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

**Packages.** Runtime dependencies flow one way: `schema` → `core` and `protocol` → `server`. `client` depends
on `schema` and `protocol` only. Plugin types derive from the client API.

| Package              | Role                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`             | Browser-safe contracts: branded IDs, domain structs, event definitions, configuration schema, the Harness and Workspace type contracts.                                                             |
| `protocol`           | The single `RpcGroup` (effect/rpc, JSON-RPC 2.0 as one JSON object per line), the protocol number, caller headers, tagged errors (copied from omac `rpc.ts`, `protocol.ts`).                        |
| `core`               | Persistence, event bus, Run and Agent execution, scheduling framework, plugin host, ports.                                                                                                          |
| `server`             | Handlers implementing `protocol`, the ACCESS table and admission, the daemon's service graph, the unix socket listener (omac `server.ts`, `daemon.ts`).                                             |
| `client`             | Effect RPC client with the per-command Ping preflight and auto-start rules (omac `client.ts`).                                                                                                      |
| `plugin`             | Plugin authoring API (Effect only).                                                                                                                                                                 |
| `effect-herdr-sdk`   | Effect client for the herdr socket API.                                                                                                                                                             |
| `runtime-herdr`      | Runtime port on herdr.                                                                                                                                                                              |
| `plugin-harnesses`   | Builtin plugins `harness-pi`, `harness-claude`, `harness-cursor`: one `HarnessDefinition` per CLI (launch side, models, subscription reader, guard answer, how its vibest plugin loads).            |
| `integration/claude` | The vibest Claude Code plugin: one hooks module whose native listeners forward Claude's events, run the guard, and deliver the inbox (omac's `packages/claude`). Loaded with `claude --plugin-dir`. |
| `integration/pi`     | The vibest Pi extension (omac's `packages/pi-omac`), bundled to one `extension.mjs`. Loaded with `pi -e`.                                                                                           |
| `integration/cursor` | The vibest Cursor CLI plugin (hooks running `vibest integration guard` / `stop`). Loaded with `cursor-agent --plugin-dir`.                                                                          |
| `plugin-git`         | Builtin: git folders as Repositories, `isolated` Workspaces.                                                                                                                                        |
| `builtins`           | The builtin plugins in load order (`pre`): `harness-pi`, `harness-claude`, `harness-cursor`, `runtime-herdr-core`, `runtime-herdr`, `runtime-choice`. Only the binary's composition root reads it.  |
| `plugin-guard`       | Builtin, on by default: the tool guard (omac `guard.ts`), through the harness integrations.                                                                                                         |
| `plugin-knowledge`   | Builtin: the Project knowledge store (omac `project.ts`).                                                                                                                                           |
| `plugin-skills`      | Builtin skills for the main Agent: delegate, pipeline. Replaceable and removable.                                                                                                                   |
| `cli`                | Composition root of the Herdr TUI product.                                                                                                                                                          |

Bun stays behind `platform/` directories and `bun.ts` adapters (`.agents/rules/bun-runtime-boundary.md`).

**Current layout (omac copied and split, every omac feature kept).** The plugin packages above are later steps; today
the code sits in:

| Package                                                  | Holds (omac source)                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema` (`@vibest/schema`)                     | The contracts `protocol` and `client` need, moved out of core modules: session, inbox and harness schemas and errors, the `project` / `session` / `inbox` / `message` rows (`model.ts`), plugin traces, Project store inputs, `RemoveOutcome`, `Layout`. Core modules re-export them. |
| `packages/protocol`                                      | `rpc.ts`, `protocol.ts`. Depends on `schema` only.                                                                                                                                                                                                                                    |
| `packages/core`                                          | Every other `packages/cli/src` module except the ones below, plus `runtime.ts` (the Runtime port, §10). Depends on `schema` and `protocol`; never on herdr (`packages/cli/test/boundaries.test.ts` checks `schema`, `core`, `server`, `protocol`, `client`).                          |
| `packages/runtime-herdr`                                 | The Runtime port on herdr: `runtime.ts` and `pool.ts` (omac `herdr-pool.ts`). The only package besides `effect-herdr-sdk` and `packages/cli` that imports herdr.                                                                                                                      |
| `packages/server`                                        | `server.ts`, `daemon.ts`.                                                                                                                                                                                                                                                             |
| `packages/client`                                        | `client.ts`. Depends on `schema` and `protocol` only.                                                                                                                                                                                                                                 |
| `packages/cli` (`@vibest/cli`)                           | `cli.ts`, `main.ts` (passes the platform's `Host` and `replacements` to the daemon), `replace.ts`, `platform/`, `bin/vibest.cjs`, the build script, and the omac CLI tests.                                                                                                           |
| `packages/integration/claude`, `packages/integration/pi` | omac's `packages/claude`, `packages/pi-omac` (with its coordinator TUI). omac's standalone `extensions/pi-tui` package is removed. `packages/integration/cursor` is new.                                                                                                              |

Each workspace package exports `./*` → `./src/*.ts`; imports name the module (`@vibest/core/db`).

## 3. Core domain

```
Project ──< Workspace ──< Agent ──< Message (inbox)
Run ──< Agent (runID)
 └─ parentAgentID → the Project's main Agent (absent when the user or a plugin started it)

AgentDefinition    Harness    Subscription    Machine
```

| Concept             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Key fields                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**         | The directory vibest starts in. A single repository is a Project as it is. Several repositories become one Project with `vibest project create`, which makes a directory and copies each repository into it as a folder (`app/`, `sdk/`, each a local git clone). Only git repositories are composed; a plain directory can still be a Project, used in place.                                                                                                                                    | `id`, `name`, `paths { machine → path }`, `folders[] { name, source }`, `setupCommand?`, `mainAgentID`, `time { creation, update, archive? }`                                                                                                                                                                                                             |
| **Workspace**       | The directory Agents run in, made by its Workspace type. `root` is the Project directory itself, where the main Agent runs; `plugin-git` adds `isolated`, a git worktree of every repository in the Project (omac #82 rules), never symlinks. A Project without git repositories has only `root`. A Workspace made for an Agent is released with that Agent; one made with `vibest workspace create` (shared by several Agents) stays until `vibest workspace release`; `root` is never released. | `id`, `projectID`, `name`, `type`, `machine`, `path`, `agentID?` (the Agent it was made for), `time { creation, release? }`                                                                                                                                                                                                                               |
| **AgentDefinition** | What to run and how to introduce it.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `id`, `description?`, `harnesses[]` (preference order), `model?`, `arguments?`, `instructions?`, `mode` (`main` \| `subagent` \| `all`), `lifetime?` (`once` \| `kept`)                                                                                                                                                                                   |
| **Harness**         | Adapter for one CLI, implementing the Harness contract (§8). The runtime maps its id to its own agent kind (herdr's kind for herdr).                                                                                                                                                                                                                                                                                                                                                              | `id`, `capabilities`, adapter functions                                                                                                                                                                                                                                                                                                                   |
| **Run**             | One or more subagents working on one input, started by `vibest run`.                                                                                                                                                                                                                                                                                                                                                                                                                              | `id`, `projectID`, `parentAgentID?`, `input`, `status`, `outcome?`, `result?`, `acceptance[]`, `time { creation, start?, end? }`                                                                                                                                                                                                                          |
| **Agent**           | One running CLI agent: one runtime pane and the agent in it.                                                                                                                                                                                                                                                                                                                                                                                                                                      | `id`, `projectID`, `runID`, `workspaceID`, `definition`, `lifetime` (`once` \| `kept`), `previousAgentID?`, `harness`, `subscription`, `machine`, `labels { key → value }`, `runtime { kind, address }`, `status` (`AgentStatus`), `outcome?` (`completed` \| `failed` \| `stopped` \| `replaced`), `result?`, `time { creation, start?, end? }`          |
| **Message**         | Text for an Agent: a task or follow-up for a subagent, or a result, report, or notice for the main Agent. Accepting and delivering are separate.                                                                                                                                                                                                                                                                                                                                                  | `id`, `agentID`, `kind` (`task` \| `message` \| `result` \| `report` \| `notice`), `sender` (`user` \| Agent id \| plugin id), `text`, `details`, `status` (`pending` \| `sending` \| `delivered` \| `failed` \| `dropped`), `outcome?` (for a task or message: `completed` \| `failed` \| `lost` \| `not_started` \| `interrupted`), `time { creation }` |
| **Subscription**    | What one harness can use on one machine: its login and usage limits. Prepared by vibest (refreshed through the harness adapter) for every supported harness, whether or not an Agent is running on it.                                                                                                                                                                                                                                                                                            | `id`, `harness`, `provider` (Pi: one login per provider; empty otherwise), `machine`, `account` (the CLI's own login for now), `limits[] { window, percent, status (available \| limited), resetTime }`, `time { update }`                                                                                                                                |
| **Machine**         | A computer that runs Agents: the local one or a remote host.                                                                                                                                                                                                                                                                                                                                                                                                                                      | `id`, `name`, `platform`, `harnesses[]`, `load`, `status` (`online` \| `offline`)                                                                                                                                                                                                                                                                         |

- **One controller per Run.** A Run is controlled by the main Agent (or the user) that ran `vibest run`,
  through `send`, `wait`, `stop`. Plugins only shape it through hooks (§7); the user can always stop any Run.
- **Subscriptions in the Run context.** Every Run hook and scheduling hook receives the current Subscriptions
  (Claude's 5-hour and weekly windows, Cursor's usage, …). The core only gathers and hands them over; plugins
  decide which harness to use, when to wait, and when to switch.
- **Conversations.** The main Agent has one active conversation per Project; `vibest --new` starts another and
  keeps the earlier ones (their CLI session ids) so they can be resumed. Knowledge belongs to the Project, so
  every conversation and every subagent sees the same preferences and memory index.
- **Project folder** (`VIBEST_PROJECT_DIR`, `projects/<project id>/`): `preferences.md` (how the user likes work done), `docs/`,
  `memories/` and `artifacts/`, read and written by every Agent of the Project with its own file tools; the guard
  keeps each Agent to its own project's folder. `preferences.md` is added to every agent's rules (16,000 characters).
  Memories are an index of at most 200 lines, not the file text. A subagent's `## Remember` section is a proposal the main Agent may write to memories.
- **Labels** are free key/value pairs for references outside vibest; grouping uses `runID`.
- **Conventions (borrowed):** branded IDs with a type prefix and a sortable body (`prj_`, `wsp_`, `run_`,
  `agt_`, `msg_`, `evt_`), each exposing `ID.create()`; one `time` struct per entity; archiving is a
  timestamp; `status` is the live state and `outcome` the finished one; every domain module exports its schema,
  events, and their inventory.
- **Not borrowed:** OpenCode's coding-agent domain (tool permissions, models and providers, message parts, token
  accounting, compaction, fork, revert). The CLI agent owns its conversation.

### 3.1 Lifecycles

**Run:** `queued → active → ended { completed | failed | stopped }`. Each time all its Agents are idle or ended,
the Run's result so far goes to the main Agent as one Message (the way a V2 subagent result wakes its parent).
The Run ends when all its Agents have ended.

**Agent status is `AgentStatus`.** vibest's schema defines `idle | working | blocked | done | unknown`, the same five
values herdr reports; `runtime-herdr` passes herdr's status through, and another runtime maps its own to them.
vibest adds no status values and no state machine over it. What herdr cannot
know is told by other fields, not by extra statuses:

| Question                                | Field                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Accepted but not yet placed or started? | `time.start` absent (`status` is `unknown` until herdr reports)              |
| Ended, and how?                         | `time.end` set; `outcome` is `completed`, `failed`, `stopped`, or `replaced` |
| Replaced by a continuation?             | `outcome: replaced`; the continuation's `previousAgentID` points here        |

`status`, Message `status`, and `outcome` are fixed enumerations: plugins observe them through hooks and cannot add
or change values.

**Agent lifetime** (`vibest run --once`, else the definition's `lifetime`, else the configuration default, which
is `kept`). An Agent is reused by its id; one that may be needed again should be `kept` from the start:

- `once`: the Agent ends `completed` when its turn ended normally (`completed`), that result was delivered to the main
  Agent, no Message for it is pending, and it is still idle (omac `--archive-on-completion`); a `failed` turn
  (the harness or turn reported an error) keeps it. Ending closes the pane and releases its Workspace (§3.3).
- `kept`: when the Agent answers, it stays `idle` with its pane open. `vibest send` continues the conversation,
  and every new answer returns to the main Agent. `vibest stop <agent>` ends it, closes the pane, and releases
  its Workspace.

**Idle:** vibest does not model the CLI agent's internal loop. herdr's `idle` is the status. A piece of work ends
when its integration reports the end of its work (Claude `Stop`, Pi `agent_settled`, …) and its inbox is empty;
that is when its result goes to its parent and the next Message is delivered. For a harness with an integration, herdr reporting idle with no hook result for
10 s makes the Message `lost` (a reason and the `vibest peek <id>` command, never screen text; the last 30 lines go to vibestd.log); only a harness without an integration treats
herdr's idle as the end.

**Outcome of a task or message** (omac's turn states, copied): a Message vibest delivered is `completed` or
`failed` by its result, `lost` as above, `not_started` when delivery could not be confirmed (§3.2), `interrupted`
by `vibest interrupt`. Text the user types into a subagent's pane is recorded as its own round and
opens no such Message; when that turn ends, the user's text and the subagent's answer go to the main Agent as one
`notice` (information, delivered with its next input, never a task it must act on).

**Results** come through the best channel (D11): the integration sends its turn-end event to the daemon, which keeps the agent's last answer in memory
(Claude `last_assistant_message`, Cursor and Pi `text`) and writes it as the turn's `turn.end` and result row; a turn end counts only if newer than the delivered Message. `vibest report "…"` sends progress, or with
`--json` a structured result validated against the requested schema; `herdr agent read` is last.

The subagent's rules ask for a final reply whose first line is a one-sentence summary, then the body, and an
optional `## Remember` (omac `results.ts`). The status is what vibest observed of the turn, never parsed from the reply. The main Agent receives (omac `results.ts`, `sessions.ts`):

```
<agent-result>
<agent-id>agt_…</agent-id> <run-id>run_…</run-id> <status>completed</status> <summary>…</summary>
<harness>claude</harness> <branch>fix/x</branch> <pushed>true</pushed> <workspace>…</workspace>
<result>full text of the last answer</result>
</agent-result>
```

`branch` and `pushed` come from git, never from the agent; a progress report arrives as `<agent-message>`.

### 3.2 Execution

Delivery follows omac `inbox.ts` and `sessions.ts` (copied):

- **Inbox.** One lock per receiver; read, mark `sending`, deliver, mark `delivered` only on success. Consecutive
  Messages from one sender are delivered as one. Triggers: on write, on the receiver's status event, a 10 s
  reconcile tick, daemon start. A `blocked` receiver gets nothing.
- **Into the main Agent** natively where the CLI allows it, as its harness adapter's `inbox` says: `poll`, the
  Claude plugin polls vibestd over HTTP on `vibest-http.sock` (each row handed out is leased for 30 s, its lease in
  vibestd's memory; ack by row id, or give rows back; a project that stops polling for 5 s gets its leases back; only the
  session's own harness may poll); `subscribe`, the Pi extension's subscription stream; `prompt`, typed through herdr
  `agent.prompt`. No main Agent pane: Messages are `dropped`. A main Agent whose terminal the runtime cannot name
  (reused, or its record dropped) is judged by its process. A `subscribe` batch counts as delivered once the RPC
  client queued it (the next pull starts only after the socket Ack), not once `pi.sendMessage` returned: a dropped Ack
  can mark a batch failed that the client already has (a known gap).
- **Into a subagent** through herdr `agent.prompt`, text unchanged, then confirmed: within 8 s the state
  sequence must move or the agent must be working; otherwise press Enter and wait 8 s; otherwise paste once more
  and wait 8 s; otherwise `not_started` with a notice naming `vibest peek <id>` (CAO #479, #496, #566). No screen text is ever
  pushed to an agent: a coordinator reads a terminal on demand with `vibest peek <id> [--lines N]`; vibestd.log keeps the tail.
- **Failure.** A Message that cannot be delivered is finalized `failed` and its text returned to the sender as a
  notice, once. A Message found `sending` after a restart is finalized as "may have been delivered": never
  replayed blindly. herdr unreachable before handover leaves it `pending`.
- **Exited agent.** Sending to a `kept` Agent whose process exited reopens its Workspace, opens a pane, and
  resumes the CLI conversation with the adapter's resume arguments; without a known conversation id it fails.
- **Restart.** Started Agents (`time.start` set, no `time.end`) with no herdr agent end with `outcome: failed`; open Messages are checked again by the
  rules above; orphan worktrees are logged, never deleted.
- Decision points (`agent.fail`, `run.end`) are recorded before their hook runs;
  after a restart an unfinished decision runs again, so plugin decisions must be idempotent.

How `packages/core/src/sessions.ts` keeps these:

- Every operation on one session runs under that session's lock; different sessions proceed in parallel. A
  session directory has its own lock (`directory:<path>`), which an archive holds while it decides whether the
  directory goes and a `--peer` spawn holds while it joins it. Per-session flags live in memory and are dropped once
  the session is no longer live and nothing is in flight on them (`forget`, under the lock).
- Remove and archive close the round and mark the session archived and exited under its lock. The aborted turn
  end their interrupt causes, landing during the interrupt or after the archive, is no result for two independent
  reasons: check returns early for an archived session, and an aborted payload with no open round collects
  nothing (`rounds.ts` `collectResult`).
- Ready for input: a harness whose integration reports ready is ready once that report is on its row (a restart or
  move removes the previous one); any other once the runtime's state is idle, working or blocked. While neither (a
  harness starting, or a startup dialog such as Claude's folder trust) the harness's startup step answers it, polled
  every 500 ms because a drawn dialog has no event. A runtime without `state` and a harness without a report are
  ready when `open` returned. What the terminal showed goes to vibestd.log only.
- Handing over a turn: the round opens before the wait for ready, so a prompt typed during a resume sees it; rows
  are claimed after ready, so a session that never gets ready does not take them. The round is open, and the
  subscription to its state taken, before the runtime gets the text, so the paste's own prompt hook is ignored and
  no turn start can come before the wait on it. Only a turn start of this round confirms pickup: the previous
  round's start would confirm a text whose Enter was swallowed. The text is pasted again once only, so a task never
  runs twice. A refused text undoes the round unless the integration wrote a result anyway or a usage-limit move
  will try the next harness; a broken connection is not a refusal (the text may have arrived), so the round stays.
- A check decides nothing for an exited session (the next Message resumes it), an archived one, or one whose harness
  vibestd is restarting. A delivery already waiting on that session does not resume once the exit has failed its
  queued sends; it decides only after that, and the next message is what resumes it. Unreachable or `unknown` status
  is no answer. No agent, while that terminal's process is
  running, is not an exit: the shell may still be starting it. That keep arms one re-check after the start
  timeout; the re-check does not arm another, and it still exits only if the runtime then reports the process gone.
  A harness whose reported
  pid has died is an exit even when that report still says the terminal is running: a launch herdr has not finished
  keeps saying so after the process was killed. A terminal the runtime cannot
  find is. A turn counts
  as worked when it was seen
  working, a turn start of this round was reported, or after a restart when it was typed or a row was delivered into
  it. Idle and never seen working: look again after the confirm timeout. Idle after working with no report: lost
  after the hook grace. A prompt that failed part way closes the turn so the queue moves again.
- A Message stays queued only for what a retry can fix (the runtime unreachable, vibestd stopping); a refused start
  is final. A session whose harness is being restarted is never resumed in another terminal.
- Placing a start (`placement.ts`): the session's `process.start` is written before its terminal exists, so what the
  harness reports while it starts (ready, its pid) belongs to it; a terminal that never opens ends it as
  `launch_failed`. The worktree comes first: the terminal's cwd is in it, the argv names it, and the
  `.worktreeinclude` files are in place before the harness starts. It is detached and made by vibest (a linked
  worktree of the main checkout would group away from the project's terminals); a multi-repository project gets one
  detached worktree per repository. A failed start undoes its steps in reverse order, uninterruptibly, before the
  failure becomes a notice: the terminal, the system prompt file, the worktree (with git, without force; a refusal,
  or a reserved directory git left something in, stays for `vibest archive`). A failed resume closes its terminal
  too. A terminal opens beside `--peer`'s, else beside the main Agent's when that runs in the same runtime. When a
  project's last live session ends, the main Agent's terminal publishes the workspace alone; without a stored
  project directory its name cannot be given again and is left as it is (a known gap).
- Starting the main Agent (`launch.ts`): every check that can refuse the launch (harness, provider, binary, plugin,
  temporary directory) runs before the coordinator session is recorded, since that supersedes the running main
  Agent's launch. The shell a launch opens at the root runs the command and then stays, so a failed start (or a
  main Agent the user quits) leaves its error and a shell, not a closing terminal. `VIBEST_HOME` is set last in its
  environment, so a caller's `--env` cannot point that shell at another vibestd.
- On start: subscribe before writing anything, settle the deliveries a stop cut off, label terminals again (the
  runtime does not keep labels), then check every live session once. The same reconcile runs when a runtime
  registers or comes back, and finishes archives and `--archive-on-completion` archives a stop cut off.

How `packages/core/src/rounds.ts` ends a round (under the session's lock, except where noted):

- A reported turn end counts only when it is from the session's current harness, stored after its current process's
  ready report (`Db.latestReport`, a fence that holds across a vibestd restart), and received after the open round's
  prompt. The `turn.end` is stamped no earlier than the report, so one report is not taken twice. A late end from the
  harness the session just left is left alone: the new harness's end replaces it. A turn stopped in its terminal with
  no round open is `vibest interrupt`'s own, or no round of vibest's. A usage-limit end moves the session to the next
  harness and the open round stays the one that finishes.
- Queued Messages: one wake is one delivery; the batch goes pending, sending, delivered, or failed with the owner
  told. A broken connection before the handover leaves it pending for the next check; after it, the text may have
  arrived, so it is not sent again and the owner decides.
- Text the user types while no round is open opens one (no inbox row). It is stamped when the hook arrives, before
  the session's lock is taken: the lock can be held for seconds (a delivery, an interrupt, an archive) and the typed
  turn may already be over when it frees, and a later stamp would drop that turn's reported end. vibest's own paste
  sets a flag around its send, so that echo is no round and the hook cannot deadlock on the lock the paste holds. A
  round that opened after the read is not recorded twice.

### 3.3 Ending and cleanup

Copied from omac `remove.ts`, `processes.ts`, `worktree.ts`. `vibest interrupt <agent>` sends the adapter's
interrupt key and waits 10 s for idle; the Agent and pane stay. `vibest stop <agent>`:

1. interrupts if working, records a tombstone, and fails its pending Messages with one notice;
2. records the pane's shell and foreground PIDs, then closes the pane; if the pane is the last one of a main
   checkout's workspace, it is first moved alone into a new workspace, because closing it would close the
   whole herdr worktree group;
3. proves exit with signal 0 (every 100 ms, 30 times); `alive` or `unknown` (no PIDs recorded, or signal 0 could
   not answer) keeps everything and a later
   `vibest stop` checks again;
4. removes a Workspace made for this Agent only when it is a listed worktree, no pane or process (lsof cwd scan)
   is inside it, `git status` is clean, and HEAD is on a branch or remote ref; `git worktree remove` without
   force; branches are never deleted.

How `packages/core/src/remove.ts` and `processes.ts` keep this:

- Every fact that guards a destructive step is asked right before that step, never reused from earlier: git state
  and live sharers are read again right before `git worktree remove`. Only a directory under vibest's worktrees root
  is removed; a row with no directory recorded closes nothing and removes nothing.
- vibest never signals a process it found or recorded. The runtime's close sees a terminal's processes off (by
  contract; vibestd still proves it by cwd before the worktree goes), and a close that failed proves nothing. The
  only signal vibest sends is SIGTERM to one harness pid it was told (a restart, a usage-limit move, a main agent
  moving terminal), never its group. A reused pid reads as alive, which can only keep more.
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
- A main agent stopped so it can start in another terminal (`Project.StopCoordinator`): its row leaves its place
  first, so the harness's exit drops nothing, and from there to the answer the stop is uninterruptible, so a Ctrl-C
  cannot leave the row detached while the harness runs. It is signalled only while the runtime sees an agent in that
  terminal, and a harness still there after 10 s gets its row back. Ceiling: local machine only (a pid names a
  process on vibestd's machine; a remote one needs a runtime operation), and a pid reused by another program while
  the runtime still sees an agent there would get the signal.

Rows are never deleted. `vibest ls` lists Agents that have not exited; `vibest ls --all` and `vibest result <id>` still show an exited one.

An archive marks the session archived before anything is closed, so from then no Send, check or resume brings it
back. A row that already exited is not closed again. A spawn reserves its worktree name with an atomic `mkdir`; a
start cut off before its terminal was recorded is undone as a failed launch (its worktree goes when nothing can be
lost, its reserved directory when still empty), while a resume or move falls back to its previous start.
`--archive-on-completion` decides on the newest result, under the session's lock: a session with work again (a queued
Message or a newer turn) stays, and a clean archive sends no notice, since each notice is a coordinator turn.

## 4. Patterns

The core knows no patterns. The one controller is the main Agent, in the conversation with the user:

- **Delegation** (§4.1) is the product: the main Agent runs subagents and gets their results back.
- **Flows over several subagents** are skills (§4.2): instructions the main Agent follows with the same commands
  (`run`, `send`, `read`, `stop`, `ls`), so the user sees and can step into every step.
- **Rules that must hold every time** are plugins on hooks (§4.3), not programs: they refuse, transform, or
  decide at one hook point, and the result still goes to the main Agent.

There is no workflow engine. Someone who wants a fixed script writes it outside vibest, as an ordinary client of
the CLI; the Runs it starts are controlled by whoever runs it.

### 4.1 Delegation (supervisor and workers)

The product, and the base of every skill; needs no plugin.

```
you ──chat──▶ main Agent
                │ vibest run "…" --agent worker        ← dispatched from the main conversation
                ▼
              Run ── worker Agent ── works; its integration forwards every step to vibest
                │                    idle event with its last answer
                ▼
              vibest ends the Run and puts the result in the main Agent's inbox
                ▼
main Agent's integration delivers it as new input     ← back in the main conversation
```

- **Main Agent.** The main Agent is an ordinary Agent: one CLI conversation, in its own Run (started by the
  user, no parent), with the same lifecycle, integration, hooks, and Messages as any other. Only three things
  mark it: its definition has `mode: main`, `Project.mainAgentID` points to it, and so it may run `vibest run`.
  `vibest` in a Project directory opens the Project's main Agent in the `root` Workspace,
  creating it on first use and resuming it if its pane is gone. The user chats with it like with any CLI agent.
- **Workers.** Only the main Agent runs `vibest run "…" --agent <definition>` (without `--agent`, the
  default subagent definition from configuration). Every Agent's pane gets `VIBEST_AGENT_ID` at `tab.create`;
  the server takes the caller's role from that Agent's stored row (§13) and refuses `run` from any other Agent,
  so subagents never nest. (Today; §1.1 plans nesting, for example a lead that spawns workers.) Run from a plain terminal,
  the parent is still the main Agent, so every result lands in the main conversation. A subagent may only
  `report`.
- **Several Agents in one Run.** `vibest run "…" --agent <definition> --in <run>` adds an Agent to a Run
  the caller controls. When all its Agents have answered, the result reaches the main conversation once, as one
  Message for the whole group.
- **Ending or keeping.** `once` Agents end on their answer (pane closed, worktree removed); `kept` Agents
  stay for follow-ups through `vibest send`, each answer returning to the main Agent, until `vibest stop`
  (§3.1).
- **Commands for the main Agent:** `run`, `send`, `read`, `stop`, `ls`, plus commands plugins add. Skills do
  not block on `vibest wait` or `--wait`: a CLI's shell tool times out long before a worker finishes, so results
  come back through the inbox (§3.2). `wait` is for scripts and the user.
- **Defaults** are configuration: the definition of the main Agent and the default subagent definition.
- **The main Agent does not edit files by default**: its guard rules refuse file edits (like omac's coordinator);
  writes go to subagents.
- **Where a subagent works** (`--workspace` overrides):
  - In a Project with git repositories: a new `isolated` Workspace made for this Agent; a reviewer shares the
    implementer's Workspace with `--peer`.
  - Without git repositories: `root`, and only one writing subagent at a time; the next one
    queues (the builtin harness choice refuses: one writing subagent at a time in such a Project).
- **Stepping into a subagent's pane** is allowed, also after it answered (a `kept` Agent's pane stays open). It
  is recorded as a round the user typed; the exchange reaches the main Agent as a `notice` (§3.1), so the main
  Agent knows what the user did, without being asked to act on it.
- **What the main Agent knows.** `vibest ls` gives every live subagent's task text, status, and latest result
  summary, so the main Agent recovers the whole picture after compaction or a restart without relying on its
  context.
- **Subagent rules** (omac `rules.ts`, copied): work on a detached HEAD, then branch, commit, and push when done;
  destructive git or file actions need the user's quoted consent; never control herdr; shared files go to the
  project folder's `artifacts/` prefixed with the Agent id; the final reply format of §3.1.

### 4.2 Skills

A skill is a named instruction document for an Agent (`{ name, description, body }`), contributed through the
`skill` catalog. The harness adapter installs skills in the CLI's own skill format where it has one (Claude Code,
Pi) and appends them to the instructions otherwise. Skills go to the main Agent only, since subagents
cannot start Agents. The main Agent gets the builtin skills and the Project's and the user's vibest skills, never
every skill installed in the CLI, so its descriptions stay few and clear.

| Skill    | The main Agent…                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delegate | splits work, runs subagents, keeps talking with the user, checks each result when it arrives, reports                                                                                                                                                                                                                                                                                  |
| pipeline | runs a read-only planner; shows the plan to the user and waits for agreement; passes the plan, verbatim, to a `kept` implementer; runs a read-only reviewer on the change and sends its comments back to the same implementer until the reviewer approves or the user decides (at most three rounds by default); then has the implementer open a pull request. All in one Run (`--in`) |

**Three ways to use them**, most used first:

1. Just say what you want; the main Agent picks a skill from its description.
2. Name it: invoke the skill in the CLI (`/pipeline …`) or say "do it as a pipeline".
3. Rules that must hold every time go in Project configuration as plugins (§4.3).

**Adding a flow** (a committee, racing, an advisor) is a skill file in `.vibest/skills/` (this Project) or
`~/.vibest/skills/` (everywhere), or a builtin skill later. It needs no core change, because every flow uses the
same commands.

### 4.3 Rules (hook plugins)

A rule is an ordinary plugin on one hook (§7), listed in the Project configuration.

Rule state lives in `storage` and decisions are idempotent, because decision hooks run again after a restart.

## 5. Service composition

- Services are `Context.Service` classes; each module exports itself as a namespace
  (`export * as Run from "./run.js"`).
- Services are assembled from a **service graph**: each entry is `{ service, layer, dependencies }` with a scope.
  A narrower scope may depend on a wider one, never the reverse, checked at type level. The graph compiles to
  one `Layer`.
- Configuration replaces entries at the composition root (`Database.entry.replace(Database.configured(...))`).
  Product identity and runtime are replacements, which is how one core yields several isolated products.
- Implemented with `LayerNode` (`packages/core/src/effect/layer-node.ts`, ported with its tests from OpenCode's
  `packages/util/src/effect/layer-node.ts`, MIT, Copyright (c) 2025 opencode; its release-tracking diagnostics are
  left out, and `unbound<E>()(service)` declares the errors a host's replacement may fail with). Each service has a
  `node` listing its `deps`; what the host supplies (sqlite, the sockets, the platform services, the daemon's
  identity) is an unbound node. `packages/server/src/app.ts` holds the roots: `services`, and `daemon`, which adds
  the RPC and HTTP servers. The daemon compiles `daemon` and the tests compile `services`, each with its own
  replacements. The platform (`packages/cli/src/platform/bun.ts`) exports `replacements` for everything it supplies
  (platform services, sqlite, the sockets, the machine transport, the plugin loader, the builtin plugins, the host
  environment, the process platform, the host facts); its `Host` keeps only `lock` and `checkDatabase`, which run
  before the graph is built. The daemon adds its `Layout`, `Identity` and `Shutdown`. The vibestd identity is the first root, so a malformed identity file stops vibestd before the database is opened. Dependencies of one node build concurrently and a group's roots build in order; a replacement drops
  the replaced node's own dependencies, so a fake is never built beside the real service.
- Today there is only the daemon scope: plugins and catalogs are the same for every Project. Tags exist in
  `LayerNode` and are not declared until a project scope is built.

| Scope       | Lives                                                               | Holds                                                                                                                    |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **daemon**  | once per daemon                                                     | Product, Database, Event bus, Project registry, Machine registry, Run and Agent execution, Scheduler queue, event stream |
| **project** | one compiled graph per Project, in a `LayerMap` keyed by Project id | Configuration, catalogs (definitions, harnesses, skills, Workspace types, commands), plugin registry and supervisor      |

## 6. Persistence and events

Copied from omac `db.ts`, on the four tables of `schema.md`:

- SQLite, WAL, STRICT tables, foreign keys on, all SQL in one service. The database carries an
  `application_id` and a `user_version`; a file that is not vibest's, or not this version, is refused before any
  writable open (`SchemaMismatch`), leaving it untouched. Migrations start with the first release.
- The check runs on a read-only connection, which sees committed WAL frames and does not checkpoint, so a refused
  database and its WAL keep their bytes (the WAL index, `-shm`, may still change). WAL mode stays off until `Db`
  accepts the file. A missing database is created mode 0600, and each open forces 0600 on the database and any
  existing `-wal` / `-shm` (SQLite copies the database's mode onto those it creates later). Closing the last
  connection may delete `-wal` / `-shm` (SQLite's default, as on Linux) or keep them (Apple's system SQLite), and two
  first opens of a missing file at once fail with `SQLITE_CANTOPEN`. A writable transaction
  is `BEGIN IMMEDIATE`, with a 5 s busy timeout.
- Tables `project`, `session`, `inbox` (delivery) and the append-only `event` (each process and turn, and each
  inbox row's queue and status changes) in `docs/design/schema.md` are the state, changed in transactions. The
  conversation is the Project's entry session row. An Agent's status is live from the runtime (memory only); its
  task is its `task` inbox row. Rows are never deleted.
- Files keep one writer each and are written to a temporary file and renamed (omac write model): system prompt
  files by the daemon (the main Agent's by `vibest`); never the user's harness configuration.
- Not stored: worktree branches and dirty state (asked from git), herdr panes and states (asked from herdr).
- Events reach the engine through one in-memory Bus (`core/bus.ts`): the Db publishes a committed transaction's rows
  in id order, and observations the schema does not store (`live.*`) are published only. A waiter subscribes before
  the action whose consequence it waits for (`awaitEvent` before its first look), so an event in between is not lost.
  The engine (`core/engine.ts`) knows events, not sessions or projects: each handler runs in a fiber of its own, a
  failing one is logged and stops nothing else, and none depends on the order events arrive in. Each re-derives what
  to do from storage under its session's lock, so a late or repeated event finds the work done or redoes it once.

## 7. Plugin architecture (Effect only)

**Definition** (`packages/plugin/src/plugin.ts`): a plugin is only an id and an effect.

```ts
export interface Plugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}
export const define = (plugin: Plugin) => plugin
```

**Two capabilities**, as OpenCode V2: `transform(editor)` with a synchronous editor (`list`, `get`, `add`, `update`,
`remove`) plus `reload()` for the definition registries, and `hook(name, callback)` for live interception. Both return
a `Registration` (`{ dispose }`) owned by the plugin's scope: unloading the plugin disposes everything it registered,
and `dispose` may be called earlier (a second call is a no-op). Registries are `packages/core/src/registry.ts`, a port
of V2's `State`: transforms apply in registration order on a lazy rebuild, a plugin's setup runs in one `group` (a
throwing transform disables the whole plugin and removes its earlier registrations), and an activation runs in one
`batch` (one rebuild and one notification however many plugins changed). Removing a plugin's transform restores the
definitions it changed or removed. Editor callbacks are synchronous: load effectful data before registering a
transform or reloading.

**Context domains** (`packages/plugin/src/index.ts`):

| Domain         | Members               | Edits                                                               |
| -------------- | --------------------- | ------------------------------------------------------------------- |
| `options`      | the plugin's options  | —                                                                   |
| `agent`        | `hook`                | `start.before`, `fail`                                              |
| `runtime`      | `transform`, `reload` | `RuntimeDefinition`s by `id`, each with its optional `caller` (§10) |
| `harness`      | `transform`, `reload` | `HarnessDefinition`s by `id` (§8)                                   |
| `subscription` | `report`              | one `(harness, provider)` row's limits                              |

Domains such as workspaces, definitions, machines, commands, skills, events, plugin RPC and storage are planned and not
part of the API yet.

**Agent hooks** (OpenCode V2 semantics, one hook domain: `context.agent.hook("start.before" | "fail", ...)`):

| Hook                 | Event (writable fields)                                                                                                      | Runs                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `agent.start.before` | `prompt`, `harness`, `provider`, `model`; read-only: project, agentType, parentSessionId, harnesses, subscriptions, attempts | before every Agent starts, the main Agent included                                       |
| `agent.fail`         | `move` (`{ harness, provider?, model? }                                                                                      | undefined`); read-only: sessionId, reason, error, turn, harness, provider, attempts, ... | a started Agent's round failed (today a usage limit) |

Every event carries the Project, the caller, the current Subscriptions, and the earlier tries. Callbacks run
sequentially in plugin order and mutate the one event in place - no per-callback copy - so a later plugin sees
(and may overwrite) what an earlier one wrote; the trace attributes each changed field to the plugin that wrote
it last. Only `agent.start.before` may refuse: `Effect.fail(new AgentRefused({ reason }))` stops the chain at
once, nothing is inserted and nothing starts; a defect or a timeout there is also a refusal (`plugin <id>
crashed: ...`, `plugin <id> timed out after 5s`), and the caller sees the plugin id and the reason. On
`agent.fail` an `AgentRefused` counts as a crash: a crash or a timeout fails that operation (the round is left
failed with the plugin error, no move). Nothing is skipped silently.

**No default harness choice.** No builtin chooses or refuses a harness by quota. A new agent without a harness
inherits its caller's harness, provider and model in core, before `agent.start.before` (§9); subscriptions are data in
the hook events for a plugin that wants to route by quota.

**Plugin API facts** (`@vibest/plugin`): vibestd maps this module and `effect` to its own instances when it loads a
plugin, so a plugin imports both normally and bundles neither. A plugin's `effect` runs once per load in the plugin's
own scope; what it registers (hooks, runtime and harness transforms) and acquires lasts until unload, and a hook name
not in `Hooks` fails its setup. In `subscriptions`, `provider` is empty for Claude Code and Cursor and set for Pi; empty `limits` means
unknown, not unlimited, and a login is limited when any of its usage windows is. A remembered limit rules its login
out until that login's own row was refreshed after it and reads fine again; a login with no row, or none named by the
attempt, keeps the plain memory. `subscription.report` replaces one `(harness, provider)` row's limits until the next usage
poll of a harness that reads usage. `agent.fail`'s `reason` is a union with one member today, `limited`.

**Counters and traces** (omac `plugins.ts`): per plugin and hook, calls, changes, crashes, timeouts, refusals,
and the last error, shown by `vibest plugins`; every trace entry is `{ plugin, hook, ms, outcome:
"ok" | "refused" | "crashed" | "timeout", changes }`, a diff against the event before that callback.

**Dispatch:** sequential in plugin order; one mutable event object passes through every callback; every
callback is bounded by a 5 s timeout (waiting on its fiber, so an uninterruptible region still returns on
time).

**Registry and supervisor:** identity `(id, revision)`; reactivation keeps the longest unchanged prefix and
rebuilds the rest in order inside a batch; a failing new revision falls back to the previous one and is not
retried until it changes; an activation latch gates entry points; builtin plugins activate while vibestd's
layers are built, before it listens, so a request that routes to a builtin runtime never finds it unregistered
(user plugins activate afterwards, in the background; a runtime a user plugin registers can still be missing for
a request admitted before that). A builtin plugin's setup must not do I/O (it connects lazily, as `runtime-herdr`
does), because every builtin setup runs before vibestd listens and a slow one would push startup past the
client's `DAEMON_START_TIMEOUT` of 10 s; triggers are configuration changes, module
file changes, and a daily update tick, debounced by 100 ms; npm plugins install into the vibest home and
activate after local ones.

**Loading and watching:** local plugin changes reload without repeating unchanged imports; failed revisions keep
the previous one. See [loading and watching](plugin-loading.md#loading-and-watching) for watch and reload details.

**Loading on Bun:** plugins share vibestd's `effect` and `@vibest/plugin` instances while local modules reload.
See [loading on Bun](plugin-loading.md#loading-on-bun) for resolution and module lifetime details.

**Order:**

```
builtin plugins         `@vibest/builtins` `pre`: harness-pi, harness-claude, harness-cursor,
                        runtime-herdr-core, runtime-herdr, runtime-choice
user plugins            configuration `plugins` and plugin directories, in order
configuration plugins   configuration files into catalogs (definitions, machines, skills)
```

**Configuration tiers** (as OpenCode: global, then project, project wins):

- global: `~/.vibest/vibest.jsonc` and `~/.vibest/{definitions,skills,plugins}/`;
- project: `vibest.jsonc` and `.vibest/{definitions,skills,plugins}/` in the Project directory, found by
  walking up from where `vibest` starts.

**Plugin entries** (as OpenCode's `plugins`): an ordered list of directives, merged across tiers in order.

| Entry                                  | Meaning                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `"@scope/vibest-plugin-x"`             | add an npm plugin                                                             |
| `"./plugins/x.ts"`                     | add a local plugin; relative to the file that names it                        |
| `{ "package": "…", "options": { … } }` | add, or configure, a plugin with options; a builtin plugin is named by its id |
| `"-check"`                             | remove a plugin, builtin ones included                                        |

Files in `.vibest/plugins/` are added without an entry. A plugin reads its options from `context.options`
(V2's `PluginOptions`) and they reload live:

```ts
export default Plugin.define({
  id: "glm-only",
  effect: (context) =>
    Effect.gen(function* () {
      const { provider, model } = context.options
      // every subagent runs on Pi with this provider and model, whatever the main Agent chose
      yield* context.agent.hook("start.before", (event) =>
        Effect.sync(() => {
          event.harness = "pi"
          event.provider = provider
          event.model = model
        }),
      )
    }),
})
```

Settings of core concepts (definitions, machines, skills) are top-level keys or files in the tier
directories, not plugin options, as in OpenCode.

## 8. Harness adapters

herdr runs the process; the adapter knows how this CLI wants to be started and told things (launch side) and
loads vibest's plugin into the CLI so its work comes back as events (integration side). The contract is
`HarnessDefinition` in `@vibest/plugin` (`packages/plugin/src/harness.ts`); `packages/plugin-harnesses` implements
Claude Code, Cursor and Pi as the builtin plugins `harness-claude`, `harness-cursor` and `harness-pi`, each adding its
definition with `context.harness.transform`. Core and the CLI hold no adapter: vibestd answers `Harnesses.List` (each
row with its `binary`) and `Integration.Guard` from the registered definitions. A user plugin may add a harness or
`update` a builtin one the same way. Each CLI runs as installed on
the machine, with its own login. Every capability has a harness-neutral fallback, so a new herdr-supported CLI
works on day one.

**Launch side:**

| Capability     | Adapter provides                                                                                                   | Fallback                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Launch         | arguments for model, autonomy level, and initial prompt; startup dialogs to answer (trust prompts)                 | definition `arguments` as given     |
| Instructions   | the native channel (system prompt flag, instruction file, skill or extension)                                      | sent as the first prompt            |
| Command access | how `vibest` commands run without an approval prompt (`run`, `send`, … for the main Agent; `report` for subagents) | the user approves once              |
| Resume         | arguments to resume a conversation from herdr's `agent_session` reference                                          | start fresh with a handoff summary  |
| Usage          | reads this CLI's usage windows into its Subscription                                                               | none: plugins see only exits        |
| Availability   | the CLI on PATH, login valid, its model list (cached 5 minutes); feeds `preflight` and `vibest harness list`       | none                                |
| Read-only      | arguments that keep the CLI from editing files (plan or read-only sandbox modes)                                   | the instruction "do not edit files" |
| Interrupt      | keys that stop the agent's current work                                                                            | `Escape`                            |

**Integration side: plugins loaded at launch, never installed.** vibest's plugin for each harness ships with the binary
(`harnesses/<harness>`, `scripts/build-harnesses.ts`): in each release archive beside `bin/vibest`, and in the
`@vibest/cli` npm package, whose platform packages hold only the binary. `bin/vibest.cjs` hands the npm directory to the
binary as `VIBEST_HARNESSES`; without it the compiled binary looks beside its own directory (`<root>/bin/vibest`,
`<root>/harnesses`, the link resolved), which is how install.sh's install runs, without Node; a binary run bare from the
npm package (a pane vibestd opened runs the binary, not the launcher) then tries the `@vibest/cli` package, flat
(`node_modules/@vibest/cli`) or nested. From source there is no layout to look beside. The adapter loads the plugin into
each session it starts, and into the main Agent: Pi `-e <dir>/extension.mjs`, Claude Code and Cursor `--plugin-dir <dir>`.
Each of these adds to what the harness loads; the user's own plugins, extensions and hooks keep loading beside it
(checked against Pi 1.4, Claude Code 2.1.316 and cursor-agent 2026.10.22). Why not install into the harness's config:

- scope: an installed plugin runs in every session of the user, not only vibest's (a fail-closed guard of a broken
  vibest would block the user's own Cursor);
- version: the plugin always matches the binary it ships with; there is no `outdated` state, update step or marketplace;
- no writes to the user's config, so no diff, backup or uninstall leftovers; Cursor's marketplace is account-level and
  cannot be installed into locally at all.

The cost: a harness started by hand does not load it, which is the intent. vibest never writes into a harness's config. `preflight` refuses a harness whose plugin directory is missing: results come only from the plugin's turn-end hook.

| vibest event                   | Claude Code              | Cursor                       | Pi                              |
| ------------------------------ | ------------------------ | ---------------------------- | ------------------------------- |
| `agent.session`                | `SessionStart`           | to verify                    | `session_start`                 |
| `agent.prompt`                 | `prompt.submit` (origin) | `beforeSubmitPrompt`         | `agent_start`                   |
| `agent.tool`                   | `tool.call`              | `preToolUse`                 | `tool_call`, `tool_execution_*` |
| turn end with last answer      | `turn.complete` (answer) | `afterAgentResponse`, `stop` | `agent_end`, `agent_settled`    |
| `agent.fail`                   | `turn.complete` (error)  | `stop` not completed         | `agent_end` with error          |
| `agent.blocked`                | `Notification`           | to verify                    | —                               |
| `agent.exit`                   | `SessionEnd`             | herdr                        | `session_shutdown`              |
| native delivery into the agent | plugin hooks module      | none (herdr typing)          | extension                       |

What omac installs and uses today: Claude `Stop`, `StopFailure`, `PreToolUse`;
Cursor `afterAgentResponse`, `stop` (not `completed` becomes an error), `preToolUse` (`failClosed`); Pi
`session_start`, `before_agent_start`, `tool_call`, `agent_end`, `agent_settled`. Every other cell is new in
vibest and is verified before it is relied on (open question 1). Until then the CLI's conversation id is taken
at the turn end (Claude `session_id`, Cursor `conversation_id`) and at Pi `session_start`.

vibest's Claude plugin uses the hooks module's native `turn.complete`, `prompt.submit` and `tool.call`, not the
classic `Stop`, `StopFailure`, `UserPromptSubmit` and `PreToolUse`: Claude fires no `Stop` for a turn stopped with Esc,
and `prompt.submit` names its origin. `turn.complete` carries no API error kind (`StopFailure`'s `rate_limit`, ...),
so a Claude usage limit is a failed result, not a usage-limit move.

**Claude Code: the plugin only.** vibest writes nothing into `~/.claude/settings.json`. The plugin (omac
`packages/claude`, copied) is a hooks module (`hooks/hooks.json` → `register.mjs`, no command hooks, no shell) whose native
listeners cover every Claude row of the table above, including `PreToolUse` for the guard, and the inbox module for the
main Agent; each listener calls the `vibest` binary on PATH. omac's settings.json script is not copied.
Claude's trust and bypass menus are answered in the pane, one key per tick, as CAO does: Down until the accept option
is under `❯`, then Enter (the trust menu preselects "No, exit"; no flag or setting skips it). The project folder's
permission rules are `Read(//<dir>/**)` and `Edit(//<dir>/**)`: Claude matches file tools only against Read and Edit
rules (an Edit rule covers Write), and `//` starts an absolute path. A user prompt is a `prompt.submit` from origin
`composer` or `bridge` (Remote Control); a task notification, a scheduled trigger, a peer or a plugin's prompt is not
the person. An aborted `turn.complete` is a result only while vibest's round is open, so `vibest interrupt`'s own Esc
is none. vibest does not read Claude's session files. It resumes with `--resume`. If that process exits non-zero within 3
seconds, the main agent starts again without `--resume` and a subagent starts again with `--session-id` instead. Its models come from
the stream-json `initialize` control request (the Agent SDK's `supportedModels()`; the list's `default` entry is
Anthropic's recommendation, not the user's setting, and is dropped) and `get_settings` (`applied.model`, what it
runs), under `--safe-mode` so no hooks or plugins run (`--bare` would skip OAuth and return a short list).

**Cursor: hook files.** `@vibest/cursor` is the plugin as files that vibest writes into its home; cursor-agent
(checked against 2026.10.22) runs a plugin directory's `hooks/hooks.json` like `~/.cursor/hooks.json`, with the plugin
root as the hook's working directory; `afterAgentResponse` carries the reply as `text`, `stop` only a status. The hook
script acts only for a vibest agent (`VIBEST_AGENT`). The guard hook is fail-closed: a crash, timeout or missing answer
refuses the call, which Cursor would otherwise let through, so the guard always answers explicitly; `allow` only lets the
call go on to Cursor's own permission checks. Every hook input carries `conversation_id`. A resume is one argument,
`--resume=<id>`: `--resume` takes an optional value, so a separate id starting with `-` would read as a flag.

**Pi: one extension.** vibest loads one extension per session for inbox delivery, turn reports, the guard and
the main Agent's TUI. Only the root TUI session participates; child modes do not. See the
[Pi integration](../../packages/integration/pi/README.md) for adapter and TUI internals.

**Arguments and models.** herdr refuses launch arguments with newlines, so Pi and Claude read the system prompt from
a file and Cursor gets it in front of its first prompt. A harness lists its models from the user's home, not the
caller's directory (a worktree may be gone since). With a request the listing keeps stdin open, since a server may
exit at EOF before it answers, and stops at the first output that holds a list. A model's provider null is the
harness's default provider; `default` marks what it runs with no model given, as its own settings decide.

**Nested conversations are filtered** (omac `integration.ts`): events carrying `agent_id` (the CLI's own
subagents), and Cursor events whose `CURSOR_CONVERSATION_ID` differs from the conversation's, are ignored.

## 9. Harness choice

Which harness an Agent runs on is decided in two steps. First core fills what the request left out
(`packages/core/src/spawn.ts`): a `vibest run` without a harness takes the harness, provider and model of its caller's
session row (the calling session, else the project's main agent when the user runs it from a plain terminal); a named
harness replaces all three, and `--provider` or `--model` alone overrides only that field; with nothing to inherit the
start fails with `NoHarnessChosen` ("no harness to inherit: name one, for example `vibest run claude -- <prompt>`").
The main agent started by `vibest` without `--harness` reuses the harness the project's main agent last used, and a
project's first start without it fails asking for `--harness`. Then the `agent.start.before` chain (§7) runs, every
plugin in order, each able to keep or overwrite what came before. There is no default harness and no builtin that
chooses or refuses by quota. vibestd validates the final harness (a plugin provides it, its plugin directory is there,
its model list reads, the model is offered) and refuses a start that never settled on one.

A usage limit is the same decision in reverse, on `agent.fail`: the round that failed stays the round that
finishes, and the session restarts — same id, same worktree, same task (the open round's input, else the text
the launch was about to send, else the trailing delivered batch) — on the harness the chain writes into
`event.move`. Before each candidate starts, the move runs the `agent.start.before` chain with the move's
harness/provider/model and the session's real attempts prefilled: a refusal skips that candidate (recorded as a
`refused` try), and what the chain decides — including a rewritten harness or prompt — is what gets patched and
started, so a start policy plugin governs a moved Agent exactly like a first start. vibest itself does not
move: with `move` still unset the round fails, naming that harness and each exhausted limit with its reset time,
and no other harness starts. A plugin may still set `move`. The pairs that already hit a limit are remembered per (harness, provider) in
`process.end` events with reason `limited` (joined to their `process.start`), so they survive moves and a vibestd
restart. Within one round (since its turn started; for a launch's own limit, since the last turn ended or the
session began) vibest never moves to a pair that hit a limit in it, whatever that login's usage reading says now:
a round that hit limits on every login it may use fails instead of cycling, and a later round may use such a login
again once its reading is free. A preflight miss, or a start or prompt that fails, is not a limit — the next move
may use that harness again. A login already limited before start is left to `agent.start.before`: without a plugin
that routes by quota, the agent starts and fails its round the usual way when the limit hits.

How the move runs (`move.ts`, under the session's lock): a choice the chains already ruled out (an unknown harness,
a login limited in this round, a harness this move skipped) ends the move, since asking the same plugins again cannot
change the answer; a limit from an earlier round no longer rules a login out once its own usage row, refreshed after
it, says it is free. The move stays on the session's own runtime and machine. It ends the old agent before the next
starts: a refused SIGTERM (sent to the harness pid alone, never its group, which is the terminal's shell) or a failed
close keeps the session where it was, so no second agent ever runs. With a runtime that can `run` in a terminal the
next harness starts in the session's own terminal, and the row names it first so what it reports while starting is its
own; otherwise the terminal closes and a new one opens before the row names the new harness, so a failed placement
leaves the row on the last live one. `open` failing with code `failed` is the start dying inside the terminal (its
own limit, a crash) and skips to the next candidate; any other code is a placement refusal and ends the move. A
prompt the runtime took whose turn never started counts as a failed prompt: the round stays working and the next
harness prompts it again. Giving up with no terminal of its own (the turn-end path) fails the round but leaves the
agent running, so check keeps polling it.

A move does not carry the model named for the old harness, which the new one would not list: the move starts on the
new harness's default. The memory of tried pairs is per harness when no login was named and per login when one was.

## 10. Ports

| Port                                                                   | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Herdr implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime** (`@vibest/plugin` `RuntimeDefinition`, runtime-port.md §3) | one `RuntimeDefinition` a plugin adds (`context.runtime.transform((editor) => editor.add(definition))`, beside `agent.hook`): required `id`, optional `name` (the place text, else the id: herdr-core's name is `herdr-core`, its id stays `hc`), optional `caller` (the environment its terminals set), `status(machine)`, and on terminals `open` (argv exactly, env, label, `near?`, `split?`, `focus?`), `send` (text/keys), `read`, `process`, `close`; optional `state`, `session`, `events` (`exited`/`state`/`reset`), `exec`, `present` (labels and tokens), `prepare`, `attach`. One error type `RuntimeError { code }` (`not_found`\|`busy`\|`unreachable`\|`incompatible`\|`failed`); `Terminal { machine, id }` stored on the Agent row, opaque to core. Core uses only required members plus optional ones when present, with the §3 fallbacks (no `events` → poll `process`; no `exec` → hidden terminal; no `present` → `open`'s label; no `state` → the harness integration's report lines and OSC 7501 only). Shared contract suite: `@vibest/plugin/testing` `runtimeContract`, run against a real local instance. Choice (§4): without `--runtime`, the runtime of the terminal vibest was started in (both herdr-core and herdr variables: hc, because builtin runtime-herdr-core loads before runtime-herdr; otherwise the first detected caller in registration order; `--runtime` override; none refused); subagent `--runtime` or its parent, coordinator included; old key warns once; machine is `local` this phase | `packages/runtime-herdr/src/terminal-runtime.ts` (`fromPool`, `id: KIND`, `KIND = "herdr"`): terminal id `<session>/<pane id>`; `Machine.target` is the caller's herdr location as JSON. `open` = `tab.create` (env only settable there) in the Project's workspace (`worktree.list` group, else a pane at the root, else `workspace.create`) plus `agent.start` for a harness argv (retried on `agent_pane_busy`; anything else typed into the pane's shell as `exec`, undone with `tab.close` when the start inside it dies); `send` → `agent.prompt`/`agent.send_keys` targeted by the agent name `open` gave (a reused pane id reads `agent_not_found`), else `pane.send_text`/`send_keys`; `read` → `pane.read`; `process` → `pane.process_info` (running = a foreground process besides the shell); `close` → the agent-identity check (the name `open` gave still in that pane), then `pane.move` (alone, so a main checkout's group survives) + `pane.close`; `state` → `agent.get` (`interactive_ready`, `done`→`idle`); `events` from the pool's broadcasts (`pane_closed`/`pane_exited` → `exited`, restart → `reset` plus re-subscribing every pane) plus per-pane `pane.agent_status_changed` → `state`; `present` → `pane.report_metadata`/`workspace.report_metadata` (source `vibest`, tokens ≤ 80 chars); `attach` → `herdr session attach`. No `exec` (hidden-terminal fallback). Loaded as the builtin `runtime-herdr` plugin (`plugin.ts`), beside `agent.hook` |
| **Harness**                                                            | §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `plugin-harnesses`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Workspace type**                                                     | create and release a directory for a Project on a machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | builtin `root`; `plugin-git` adds `isolated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Product**                                                            | name, home, socket, environment prefix, executable name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| herdr connection                                                       | one client per herdr session (current session inside herdr, a named headless session started by vibest outside it), protocol pinned in `effect-herdr-sdk` and checked by `ping` on every connect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/runtime-herdr/src/pool.ts` (omac `herdr-pool.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **MachineTransport**                                                   | reach a machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the runtime plugin's connection (`runtime-port.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 11. Herdr TUI surface

The Herdr TUI product makes vibest usable inside herdr through herdr's own extension points (herdr 0.9.5).

- **herdr plugin** in `packages/cli` (`herdr-plugin.toml`). Every entrypoint runs `vibest <command>` and
  reads `HERDR_PLUGIN_CONTEXT_JSON`; the plugin holds no state.
  - Actions with keybindings: open the main Agent, run a definition on behalf of the main Agent,
    stop. The focused pane resolves to its Agent and Run.
  - Panes: a Run list overlay (each Run with its Agents); a Subscriptions overlay (usage per harness); a command palette popup listing the
    `command` catalog, which is how vibest plugins reach herdr without runtime action registration.
  - The daemon already subscribes to herdr events (§10); the plugin adds no event hooks of its own.
  - A startup hook asks the daemon to republish metadata, since herdr does not restore tokens.
- **Presenter** (Product side of the runtime) projects vibest events onto herdr:
  - pane metadata: `display_agent` (`reviewer · claude`), `state_labels` (`blocked` → `waiting for you`),
    tokens `$definition`, `$run`, `$subscription`, `$machine`, plus labels;
  - workspace tokens: Project name and live Run count, filling the gap that herdr groups only by Repository;
  - `agent.view.set` views: this Run, everything needing the user in this Project;
  - `notification.show` on results, `blocked`, and limits.
- **Sidebar layout** rows using these tokens are written to the user's herdr `config.toml` only under
  `.agents/rules/user-file-mutation-safety.md`.
- **Machines** map to herdr saved machines; remote Agents appear in the combined agent list.
- **Limits:** one agent view at a time for the whole server; at most 32 tokens per pane and 80 characters per
  value; no non-terminal UI.

## 12. Multiple machines

Designed in [`runtime-port.md`](runtime-port.md): vibest saves machines (`vibest machine add`), each names its
runtime plugin and target, and the runtime connects; connections go outward only. A plugin picks an Agent's machine
in `agent.start.before` (builtin: `local`). A Project runs on another machine only through its git remote (same
remote there; the start commit must be pushed). An offline machine's Agents show `offline`, not failed.

## 13. Surfaces and protocol

```
vibest project create <directory> --from <repository>…   copy repositories into a new Project directory
vibest [--new] [--harness <h>]          in a Project directory: open its main Agent here (create or resume it)
vibest run [--agent <definition>] [--in <run>] [--once] [--machine …] [--workspace …] [--wait] "prompt" | -- <prompt|->
vibest send <agent> -- <text|->         queue; delivered when the agent is idle
vibest interrupt <agent>                stop its current work, keep it
vibest stop <run|agent>                 end it (§3.3)
vibest wait | resume <run>
vibest ls [--run …] [--all]             Runs and their Agents
vibest read <agent> · attach <agent> · result <run|agent> · events [--run …]
vibest report [--json] -- <text|->      from inside a subagent
vibest project info | search                                                     the project folder's paths, text search
vibest daemon [--foreground] · daemon restart · status · update · doctor · plugins · models [<harness>]
vibest harness list | models <harness>
vibest integration guard | stop --harness <h>   internal: what the harness plugins call
vibest project | workspace | definition | subscription | machine …
```

Plugins add subcommands through the `command` catalog.

**Conventions for agents** (omac `cli.ts`): queries print one JSON document on stdout; errors print
`<Tag>: <message>` on stderr; exit codes 0, 1 failure, 2 usage, 130 interrupted; text is a literal argument or
`-` for stdin, empty text is `EmptyInput`, `@file` is not expanded.

**Protocol** (omac `rpc.ts`, `protocol.ts`, `server.ts`, `client.ts`, copied): effect/rpc over the unix socket,
one JSON-RPC 2.0 object per line, transport-agnostic so a WebSocket or HTTP transport can be added for another
host. Every method but `Ping` needs the `vibest-protocol` header; each command Pings once first and stops with
`IncompatibleDaemon` on a mismatch; the package version is informational. `PROTOCOL` is the only version, for RPC
and the HTTP API alike (HTTP paths carry none); old versions are not served. An additive feature does not bump it:
Ping's `capabilities` gets a boolean flag, and a client uses the feature only when the flag is there. Flags: `http`,
`handoff`, `requests` (`Send` and `Spawn` take an optional `request` id: `vibest send` and `vibest run` make one per
invocation and send a call whose connection dropped once more with it, and vibestd answers a repeat as the first;
only to a vibestd that has the flag, since an older one would act on a repeat twice, and never after an answer, a
refusal included). A mismatch is
answered with what vibestd speaks (protocol, package version), a message and the command to run (`protocol.ts`
`protocolMismatch`, the command in `MISMATCH_ACTION`): both ways it is `vibest update`, which restarts the agents on
the new version; an older caller is told vibest was updated, a newer one that vibestd is older. RPC fails with `ProtocolRejected`, HTTP answers 409. Scoped methods need caller headers
(`user` with a Project directory, or `agent` with `VIBEST_AGENT_ID`); the role comes from the stored row, and
missing or mixed headers are `InvalidCaller`, never the user. The ACCESS table lists every method, checked at
compile time: open (integration notifications), subagent (`Report`), main Agent or user (`Run`, `Send`,
`Interrupt`, `Stop`, …, only on Runs of its Project), user only (daemon, update). Socket mode 0600 is
the authentication; roles prevent mistakes, not attackers.

**RPC methods** (`packages/protocol/src/rpc.ts`). Three middlewares: `ProtocolGate` (every method but `Ping`),
`CallerGate` on scoped methods (resolves the caller for that request only, from its headers and the stored row; a
session never declares itself coordinator), and `Admission` on methods that change something (see
[drain admission](daemon.md#admission-while-draining)). Protocol-only methods take no caller: `Plugins`,
`Harnesses.List` (each harness with `problem`, null when vibestd can start it, else why not, and the models it lists;
the same preflight `Project.StartMain` and `Spawn` route by, so the catalog and a start never disagree; `vibest models`
and `vibest harness list` print it), `Runtimes.Doctor`, `Subscriptions`, `Republish` (put terminal labels back after the runtime started or restarted;
answers how many), the hooks' `TurnEnd` and `Prompt` (verbatim harness JSON read with the adapter's `turnEnd` /
`userPrompt`; unknown ids, another harness than the session's, and events the adapter ignores change nothing; a
prompt from the main agent or from vibest's own delivery is ignored), and `CoordinatorSessionReady` (the conversation
id a harness made for a coordinator; the last report wins). Of the rest:

- `Spawn`: `harness` is optional when a routing plugin picks it; `agent` defaults to general and may not be the
  coordinator; `machine` defaults to `local`; `peer` shares that session's worktree in a split of its pane;
  `archive` archives the session once a completed result reached its coordinator.
- `Send` queues and returns; vibestd delivers once the session is idle, and failures reach its coordinator as
  notices. An `id` is a session id or a unique prefix of at least 8 characters, and the answer names the full id.
- `Remove`: only the session's own coordinator or the user's command line. `Get` never waits. `Peek` reads the last
  `lines` (default 30) of the terminal when asked: screen text is never pushed to an agent, so a coordinator looks
  there itself when a turn ended without a report. `Report` goes to the caller's own coordinator.
  `Inbox.Subscribe` streams the coordinator's inbox batches (the Pi extension) instead of the runtime's prompt.
- `SessionInfo.task` is the first row delivered from the user or the parent (`List` cuts it to 500 characters);
  `latest.summary` is `metadata.summary` when that is a string, else the output's first line.
- `Launch` opens `vibest`'s main agent outside the repository's workspace: a tab there, or a new workspace at its
  root, whose shell runs argv. `Project.Open` finds or makes the project of the directory (`move` answers a
  `ProjectMoved`). `Project.StartMain` picks the main agent's harness, provider, model and runtime and writes
  nothing. `Project.CoordinatorSession` then upserts the coordinator row at its terminal and returns the harness
  command the CLI execs, with the caller's PID. A main agent's pane does not keep those variables in its shell.
  `Project.RunningCoordinator` finds a coordinator in another pane; `Project.StopCoordinator` sends SIGTERM to its
  recorded PID only, keeps its terminal, and answers `stopped`, `running` (nothing changed), `moved` (the row is no
  longer there) or `unsupported` (with the reason).
- `Watch` and `Session.Seen` (user only, `projects` capability) serve the desktop. A Watch session carries `turn` (the
  runtime's count of finished turns, null without `seen`) and `status` `done` when it is idle and its turn is past
  the runtime's seen mark; a project carries `activity`, the first of blocked, done, working its live sessions show,
  else idle (herdr's order: a finished agent waiting for the user outranks a busy one). `Session.Seen({id, turn})`
  raises that mark to `turn` only when it rises and no further than the runtime's count; anything else writes nothing.
- `Daemon.Stop` (user only, naming the instance from Ping): accepted, not exited; a client sends it once and
  watches Ping. `Daemon.Handoff` (`handoff` capability) checks that `command` opens the database, drains as
  `Daemon.Stop` does, starts `command daemon --foreground --import`, then hands over its sockets and lock; a
  failure before that leaves it serving. `spawnDaemon`'s `env` reaches only the new vibestd's environment.
- A restart in place types the main agent's harness command into its shell with the identity variables as an env prefix, so the shell does not keep them.
  `Session.Ready` is the integration saying the harness takes input, with the harness's own `pid`; vibestd hands over a
  first or restarted turn only after it.
- `Agents.Outdated` lists live agents whose integration is not this vibestd's (`blocked`: why one cannot restart in
  place). `Agents.Restart` returns at once and, once process `after` exited, restarts them in place: subagents
  first (at most 4 at a time), then main agents; SIGTERM to the harness alone, then the runtime runs it again on
  the same conversation. An interrupted subagent turn gets a continue turn, a working main agent a continue notice
  naming the outcomes, which also go to vibestd.log.

**Client** (`packages/client`). One short connection per command; the Ping preflight is the only Ping, and the
call itself carries its headers. The RPC protocol layer is built into the caller's scope: `Effect.provide` would
close the socket as soon as the client is made. Its keep-alive ping timeout is a day, because the JSON-RPC
serialization does not encode keep-alive pings and the default 5 s timeout would cut every longer call (an
`Inbox.Subscribe` stream); a closed unix socket still fails the read at once. An incompatible vibestd that `vibest
daemon restart` cannot replace is stopped by the user: vibest prints the PID check and `kill -TERM`, and never
signals it.

**Daemon:** only the user starts vibestd; replacement drains daemon operations, not running agents.
See [daemon lifecycle and replacement](daemon.md#lifecycle-and-replacement).

**Daemon start:** a start lock serializes startup and handoff; a successor never removes a live daemon's socket.
See [daemon start](daemon.md#daemon-start).

**Admission while draining:** new changes are refused while already-started work can settle.
See [drain admission](daemon.md#admission-while-draining).

**Session requests:** each request is checked against its session and Project; main Agent starts are serialized
per Project. See [session requests](daemon.md#session-requests).

**HTTP API** (`vibest-http.sock`, `packages/server/src/http.ts`): what an integration that can only make HTTP requests
calls (the Claude plugin's `$.http.fetch`). Every route is `POST /<route>` with a JSON body, answered at once; the
caller is named by the shared session headers.

| Route                          | Answer                | What                                                             |
| ------------------------------ | --------------------- | ---------------------------------------------------------------- |
| `/inbox/poll`                  | `{ ids, line, text }` | the main Agent's next batch, each row leased (Inbox.poll)        |
| `/inbox/ack { ids, release? }` | `{ acked }`           | delivered, or given back (Inbox.ack); a settlement               |
| `/hooks/<harness>/turn-end`    | 204                   | the adapter's `turnEnd`, kept as the turn's report; a settlement |
| `/hooks/<harness>/prompt`      | 204                   | the adapter's `userPrompt`: the round starts; a settlement       |
| `/hooks/<harness>/guard`       | `{ deny? }`           | Guard.check with the session's own agent and project folder      |

Errors are `{ error }`: 409 another protocol (with `ProtocolMismatch`), 404 no such session or route, 403 another
project, another harness than the session's, or a poll from what is not a main Agent whose harness polls, 503 vibestd
is stopping. Routes match on the path alone, whether the server reports it with or without scheme and host. The guard
reads the session's project folder as its terminal's `VIBEST_PROJECT_DIR`, which vibestd itself has none of.
`Session.Ready`, sent once at the harness's start with the harness's own pid (which a restart signals), says it takes
input now; vibestd waits for it before handing the harness a turn.

**Distribution:** install.sh and npm ship the same compiled binary; updates use the original install method.
Installs stay outside the data home. See [distribution](distribution.md) for packaging, launchers and update checks.

## 14. Home layout

`~/.vibest` already holds data from an earlier project (`logs/`, `pty/`, `storage/`); vibest never touches
those. The vibest install itself is not here: install.sh puts it in `~/.local` (see [distribution](distribution.md)),
npm in its prefix. Its own entries:

```
~/.vibest/                   (VIBEST_HOME overrides)
  vibest.jsonc  vibest.db  vibest.sock  vibest-http.sock  vibestd.pid  vibestd.log
  definitions/  skills/  plugins/  packages/
  projects/<project id>/     the project folder: preferences.md, docs/, memories/, artifacts/
  worktrees/<repository>/<name>/   isolated Workspaces (omac naming, `.worktreeinclude` copied)
```

The system prompt each harness gets is not kept here. It is generated again from the session's row and the
Project's files on every harness start (new, resume, restart, move to another harness) and written to
`$TMPDIR/vibest/<session id>/system-prompt.md`; without TMPDIR, to `/tmp/vibest-<uid>/<session id>/`, a directory
that must be the user's own with mode 0700 and no symlink, checked with one `lstat` that does not follow a link, so
nothing can be swapped between two checks. Archive removes the session's directory once its processes have exited
(they may still read the prompt or report a turn end); the system cleans the rest.

`vibest project create` (`core/project-create.ts`) checks everything before it writes anything, and on failure or
interruption removes only what it created. Each copy is independent (`--no-hardlinks`, no alternates), on the
source's branch, with the source's origin, `origin/*` refs and upstream; the local path it was cloned from is not
kept as a remote, and uncommitted changes are not copied. A directory is a multi-repository project when it is not
itself in a git checkout and its direct children are main checkouts; a directory of linked worktrees is a Workspace,
whose project is the shared parent of those main checkouts (one level).

An isolated Workspace (`core/worktree.ts`) is one detached worktree per repository; no branch is created, so a
leftover `refs/heads/vibest/<name>` cannot fail it. A worktree is recorded before `git worktree add`, so a failure
or interrupt during the add still removes what git left. `.worktreeinclude` (gitignore syntax, the Claude Code
convention) copies only paths git ignores both in the main checkout and in the worktree (a rule only the main
checkout has would leave the copy untracked); git does the matching, and a nested repository is never included. A
symlink is recreated as the same link, never followed; a path that exists in the worktree or lies under a link there
is left alone (git check-ignore fails on a path beyond a symlink). Nothing is recorded in git.

## 15. Copied from omac and refactored (D12)

Source paths are in `iamdin/pi-orchestrator` (`packages/cli/src` unless shown). The omac tests named come along
and are the acceptance for each part.

| Part                                       | omac source                                                                                                      | Refactor                                                                        | omac tests                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| herdr client                               | `packages/effect-herdr-sdk`                                                                                      | regenerate for herdr 0.9.5, pin its protocol                                    | —                                                                                                          |
| herdr connections                          | `herdr-pool.ts`                                                                                                  | moved to `runtime-herdr/pool.ts`                                                | `live.test.ts`                                                                                             |
| Protocol, caller, ACCESS, admission        | `rpc.ts`, `protocol.ts`, `server.ts`, `client.ts`                                                                | methods for Run, Agent, Message, knowledge; roles main / subagent / user / open | `rpc.test.ts`, `cli.test.ts`                                                                               |
| Daemon lock, instance, replacement, update | `daemon.ts`, `core/drain.ts`, `replace.ts`, `cli.ts`, `update.ts`                                                | blockers are unfinished daemon operations, never Agents                         | `daemon.test.ts`, `stop.test.ts`, `update.test.ts`                                                         |
| Distribution                               | `packages/cli/bin`, `packages/cli-*`, `build-flags.ts`, `scripts/build.ts`                                       | names                                                                           | `launcher.test.ts`, `release-smoke.test.ts`                                                                |
| Database                                   | `db.ts`, `platform/bun.ts`                                                                                       | tables of §6                                                                    | `unit.test.ts`                                                                                             |
| Starting an Agent                          | `spawn.ts`, `worktree.ts`, `harness.ts` (the `Harnesses` registry; the adapters are `packages/plugin-harnesses`) | session → Agent in a Run; Workspace types                                       | `sessions.test.ts`, `worktree-group.test.ts`                                                               |
| Delivery and outcomes                      | `prompting.ts` (prompt), `sessions.ts` (turns), `inbox.ts`                                                       | turn state → Message `outcome`; coordinator → main Agent                        | `sessions.test.ts`, `self-heal.test.ts`                                                                    |
| Results                                    | `results.ts`                                                                                                     | add Run id                                                                      | `unit.test.ts`                                                                                             |
| Interrupt and stop                         | `sessions.ts`, `archive.ts`, `remove.ts`, `processes.ts`                                                         | archive → `stop`; `--archive-on-completion` → `once`                            | `remove.test.ts`, `stop-coordinator.test.ts`                                                               |
| Main Agent launch and resume               | `launch.ts`, `main-agent.ts`, `sessions.ts`                                                                      | coordinator → main Agent of a Project                                           | `stop-coordinator.test.ts`                                                                                 |
| Rules                                      | `rules.ts`                                                                                                       | subagent rules; main Agent rules become builtin skills                          | `unit.test.ts`                                                                                             |
| Knowledge                                  | `project.ts`                                                                                                     | directory realpath → Project id                                                 | `project.test.ts`                                                                                          |
| Models                                     | `models.ts`                                                                                                      | Availability capability                                                         | `unit.test.ts`                                                                                             |
| Integrations                               | `integration.ts`, `packages/claude`, `claude-inbox.ts`, `packages/pi-omac`                                       | forward the §8 events; agent instead of session                                 | `integration.test.ts`, `claude-inbox-*.test.ts`, `claude-integration-stop.test.ts`, `cursor-allow.test.ts` |
| Guard                                      | `guard.ts`                                                                                                       | `plugin-guard` on `agent.tool`; roles main / subagent                           | `guard.test.ts`                                                                                            |
| Plugin loading                             | `plugins.ts`, `plugin-sources.ts`, `platform/plugin-source.ts`                                                   | V2 API and the §7 kinds; keep counters, traces, reload                          | `plugins.test.ts`, `plugin-reload.test.ts`, `plugin-binary.test.ts`                                        |
| Test fakes                                 | `packages/cli/test/fakes.ts`                                                                                     | fake herdr Layer for the new services                                           | —                                                                                                          |

Every omac feature is kept, the Pi coordinator TUI included; the harnesses are Claude Code, Pi,
and Cursor. Replaced only as the refactor lands:
the one-coordinator-per-repository schema (Projects, Runs, and Agents replace it) and omac's single
`session.start.before` hook (§7).

## 16. Milestones

The phases, their order, and when each is done are in `plan.md`.

## 17. Open questions

1. Adapter capabilities, verified on real CLIs: native instructions, resume, usage limits, read-only modes, and
   every §8 event omac does not use yet, for Claude Code, Cursor, and Pi.
2. Limit state: adapter capability per harness, or a shared source (herdr's `agent-quota` plugin, provider usage
   endpoints) that adapters fall back to?
3. Machines: answered in `runtime-port.md` (runtime plugins connect; no vibest agent on remote machines).
4. Time-based waits (Agents not yet started, waiting for a reset, recurring Runs): plugin deadlines in `storage`, or a core
   schedule modeled on OpenCode's `in` / `at` / `every` / `cron`?
5. The single herdr agent view: how vibest shares it with other herdr plugins.
6. Projects without git repositories are new (omac requires git): which omac rules (worktree, cleanup, git
   state in results) apply, and how the main Agent is placed.

## Appendix A. Patterns borrowed from OpenCode V2

Paths are in `anomalyco/opencode` at `f0944f0`. These are sources to read when implementing, not vocabulary.

| vibest                                         | Pattern                                                                                                         | Source                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain in core, implementation in plugins (D2) | schema contracts with internal plugins implementing them                                                        | `packages/schema/src/goal.ts` with `packages/core/src/plugin/goal.ts`; `packages/schema/src/provider.ts` with `packages/core/src/plugin/provider/` |
| Package layering (§2)                          | one-way runtime dependencies; client never imports core or server                                               | `AGENTS.md:2`, `packages/schema/AGENTS.md`                                                                                                         |
| Result to parent (§3.1)                        | a subagent result wakes its parent                                                                              | `SessionIdleBackground` in `packages/plugin/src/effect/session.ts`                                                                                 |
| Service graph and scopes (§5)                  | typed dependency graph over Layers, scope tags, replacement-based configuration                                 | `packages/util/src/effect/layer-node.ts`, `app-node.ts`, `packages/server/src/routes.ts:118-150`                                                   |
| Per-Project graph (§5)                         | one compiled graph per key in a `LayerMap`, evicted on failure                                                  | `packages/core/src/instance.ts`, `location-service-map.ts`, `instance/service.ts`                                                                  |
| Plugin API (§7)                                | `Plugin.define`, `Registration`, `transform` / `reload`, `hook`, domains as `Pick`s of client APIs              | `packages/plugin/src/effect/plugin.ts`, `registration.ts`, `packages/plugin/AGENTS.md`                                                             |
| Catalog state (§7)                             | synchronous editors replayed in registration order, batched change notification                                 | `packages/core/src/state.ts`, `packages/plugin/src/effect/provider.ts`                                                                             |
| Hook dispatch (§7)                             | sequential, single mutable event, decision fields, no timeout (transform, refuse, decision)                     | `packages/core/src/plugin/hooks.ts`                                                                                                                |
| `agent.fail`, `agent.prompt` (§7)              | retry decision, prompt rewrite                                                                                  | `retry`, `prompt` in `packages/plugin/src/effect/session.ts`                                                                                       |
| Registry, supervisor, order (§7)               | `(id, revision)`, prefix reactivation, fallback, latch, builtin / user / configuration order                    | `packages/core/src/plugin.ts`, `plugin/supervisor.ts:152-162`, `plugin/internal.ts`                                                                |
| AgentDefinition (§3)                           | definition with `mode`                                                                                          | `packages/schema/src/agent.ts`                                                                                                                     |
| Subscription limits (§3)                       | per-window meter (V2: `{ percent, limited, resetsAt }`)                                                         | `packages/schema/src/usage-limits.ts`                                                                                                              |
| IDs (§3)                                       | prefixed branded IDs with sortable bodies and `create()`                                                        | `packages/schema/src/identifier.ts`, `session-id.ts`                                                                                               |
| Global and project configuration (§7)          | global directory, then project files found walking up from the working directory                                | `packages/core/src/config/discovery.ts`                                                                                                            |
| Plugin entries (§7)                            | ordered `plugins` directives: name, path, `{ package, options }`, `-id` to remove; options on `context.options` | `packages/schema/src/config/plugin.ts`, `packages/core/src/config/plugin/source.ts`, `packages/plugin/src/effect/plugin.ts`                        |
| Configuration through plugins (§7)             | configuration files projected into catalogs by builtin plugins                                                  | `packages/core/src/config/plugin/agent.ts`                                                                                                         |

Where vibest differs: protocol, persistence, delivery, and daemon come from omac (§15), not from OpenCode;
graphs are per Project, not per directory; decision points survive restarts; notify hooks have a timeout; no
coding-agent domain; harness adapters sit on top of an external runtime (herdr).
