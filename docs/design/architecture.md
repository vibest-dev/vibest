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

Only this shape is supported: one main Agent and its subagents, one level deep (D13).

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

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The runtime (herdr first) runs panes and processes. What happens inside a CLI agent reaches vibest first through harness integrations (hooks, plugins, extensions); the runtime's state detection and screen reading are the fallback. Per-CLI differences live only in harness adapters.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D2  | The core defines the domain (schema contracts, lifecycles, execution, scheduling framework). Implementations and rules are plugins, builtin by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D3  | The execution unit is the **Run**: one or more subagents working on one input. The core defines no orchestration patterns and no roles. Every Run is controlled by the main Agent (or the user) that started it. A flow over several subagents is a skill the main Agent follows; there is no workflow engine or program controller. Plugins observe, refuse, transform, schedule, and enforce rules (such as "a writing subagent is done only when the tests pass"); they never start or steer Runs.                                                                                                                                                                                                                  |
| D4  | `vibest` runs inside a Project directory and opens that Project's main Agent; there is always exactly one, with one active conversation and earlier ones kept (`vibest --new`). There is no separate `launch` command: the main Agent starts through the same path as every Agent, placed in the current terminal. `vibest run` starts subagents, and only the main Agent (or the user) can run it: subagents never start Agents, so there is no nesting. Every result, and every exchange the user has directly with a subagent, returns to the main Agent.                                                                                                                                                           |
| D5  | Plugins follow OpenCode V2 exactly, Effect only (no Promise edition).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D6  | Products are composed per host from shared packages; hosts are fully isolated (no shared daemon, database, or Runs). The Herdr TUI product comes first; the herdr-core desktop application comes after the base capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D7  | Machine and multi-repository Project dimensions exist from the first commit; one machine and one repository are special cases. Several repositories are composed by copying them into one directory, never by symlinks (Node and other toolchains break on symlinked folders).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D8  | In scope now: delegation (main Agent and subagents); the `pipeline` skill (plan → implement → review → pull request); the `check` rule plugin; multi-machine scheduling. Other multi-agent flows (committee, racing, advisor, …) are added later as skills, by us or by the user, without core changes. Out of scope: DynamicWorkflow and any workflow engine, work-item intake, several accounts per CLI (each CLI's own login is its one Subscription for now).                                                                                                                                                                                                                                                      |
| D9  | Names are spelled out (`repository`, never `repo`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D10 | vibest keeps a **Subscription** for every supported harness on every machine, with its usage limits, and hands the current set to plugins in each Run's context. Choosing a harness, waiting, or switching is plugin scheduling. Usage limits come only from official or CLI-provided sources, so a harness that offers none keeps an empty limits list and that is fine; a Subscription is per (harness, provider, machine), provider empty for a single-login harness (Claude Code, Cursor) and set for Pi; vibest never refreshes or rotates a CLI's token, and an expired or unreadable token skips that poll so the limits stay as last known (or unknown). Any vibest plugin may report a Subscription's limits. |
| D11 | Information comes through the best channel each CLI offers: hooks forward events and results where a CLI has them; an agent's own `vibest report` is for explicit or structured results; reading the screen is last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D12 | Where omac's implementation is good, vibest copies its code and tests and refactors them (session → Agent and Run, inbox row → Message, plugin hooks → §7 kinds) instead of designing again. §15 lists every part.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D13 | Only the main-Agent-and-subagents shape is supported, one level deep. Deeper shapes (subagents starting Agents, agent-to-agent messages) are decided case by case later. To keep that possible, the limits live in the default policy plugin, not in the data model: Messages have a sender and a receiver, an Agent records who started it, a Run holds several Agents.                                                                                                                                                                                                                                                                                                                                               |
| D14 | vibest is not bound to herdr. `schema`, `core`, `server`, `protocol`, `client`, the harness adapters, and the integrations never import herdr or name its types; they use the Runtime port (§10) and vibest's own types (Agent `status`, `runtime { kind, address }`). Everything herdr-specific (`effect-herdr-sdk`, `runtime-herdr`, the herdr plugin, the presenter) lives in herdr packages and the herdr product. Runtimes are plugins registering the `Runtime` API (`runtime-port.md`, `runtime-api.ts`): herdr, rex and tern are builtin; another product is a new plugin, not a core change.                                                                                                                  |

## 1. Architectures vibest must host

The survey groups orchestrators by the unit above a single agent. All of them need only "start an agent, prompt
it, see it go idle, read its result, message it"; they differ in that upper unit and in who decides the next
step. vibest is type B, the product a person uses every day; the other types are covered only as far as the
main Agent can run them with a skill (§4).

| Type                      | Examples                                                                                | Unit above the agent | In vibest                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| A. Direct launch          | Paseo, hcom, DMux, Autonomous Harness                                                   | none                 | the user runs `vibest run` from a terminal: a Run with one Agent              |
| B. Main Agent with a team | CAO, OpenRig, Shogun, oh-my-claudecode, ClawTeam, Squad, Paradev MCP, WSP               | a team               | **the product**: the main Agent runs subagents (one level)                    |
| C. Work-item driven       | Gas Town, Cyrus, Machinist, Emdash, Orchestrator.inc, Kandev, Cezar                     | issue or card        | out of scope                                                                  |
| D. Workflow / pipeline    | CAO workflows, Prowl, herdr-orch, obra, Fusion, Raven, Cotal Lang, pi-dynamic-workflows | workflow run         | a skill the main Agent follows (`pipeline`); no workflow engine               |
| E. Message mesh           | hcom, Agmsg, Cotal, Block Buzz, herdr-msg, Concord                                      | channel              | out of scope (D13)                                                            |
| F. Racing / best-of-N     | Orca, Uzi, Pragma, Claudexor                                                            | attempt group        | a skill, added when needed: one Run with N Agents, compared by the main Agent |

## 2. Layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Products (apps/): vibest-herdr = product identity + runtime-herdr          │
│                   + herdr plugin + presenter + CLI                         │
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
| `plugin-harnesses`   | Builtin: one harness adapter module per CLI (launch side, and how its vibest plugin loads).                                                                                                         |
| `integration/claude` | The vibest Claude Code plugin: one hooks module whose native listeners forward Claude's events, run the guard, and deliver the inbox (omac's `packages/claude`). Loaded with `claude --plugin-dir`. |
| `integration/pi`     | The vibest Pi extension (omac's `packages/pi-omac`), bundled to one `extension.mjs`. Loaded with `pi -e`.                                                                                           |
| `integration/cursor` | The vibest Cursor CLI plugin (hooks running `vibest integration guard` / `stop`). Loaded with `cursor-agent --plugin-dir`.                                                                          |
| `plugin-git`         | Builtin: git folders as Repositories, `isolated` Workspaces.                                                                                                                                        |
| `plugin-scheduling`  | Builtin: the default harness choice and limit move (id `harness-choice`).                                                                                                                           |
| `plugin-guard`       | Builtin, on by default: the tool guard (omac `guard.ts`), through the harness integrations.                                                                                                         |
| `plugin-knowledge`   | Builtin: the Project knowledge store (omac `project.ts`).                                                                                                                                           |
| `plugin-skills`      | Builtin skills for the main Agent: delegate, pipeline. Replaceable and removable.                                                                                                                   |
| `plugin-check`       | Builtin rule, off until configured: a writing subagent is done only when a check command passes (§4.3).                                                                                             |
| `apps/vibest-herdr`  | Composition root of the Herdr TUI product.                                                                                                                                                          |

Bun stays behind `platform/` directories and `bun.ts` adapters (`.agents/rules/bun-runtime-boundary.md`).

**Current layout (omac copied and split, every omac feature kept).** The plugin packages above are later steps; today
the code sits in:

| Package                                                  | Holds (omac source)                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema` (`@vibest/schema`)                     | The contracts `protocol` and `client` need, moved out of core modules: session, inbox and harness schemas and errors, the `project` / `session` / `inbox` / `message` rows (`model.ts`), plugin traces, Project store inputs, `RemoveOutcome`, `Layout`. Core modules re-export them. |
| `packages/protocol`                                      | `rpc.ts`, `protocol.ts`. Depends on `schema` only.                                                                                                                                                                                                                                    |
| `packages/core`                                          | Every other `packages/cli/src` module except the ones below, plus `runtime.ts` (the Runtime port, §10). Depends on `schema` and `protocol`; never on herdr (`apps/vibest-herdr/test/boundaries.test.ts` checks `schema`, `core`, `server`, `protocol`, `client`).                     |
| `packages/runtime-herdr`                                 | The Runtime port on herdr: `runtime.ts` and `pool.ts` (omac `herdr-pool.ts`). The only package besides `effect-herdr-sdk` and `apps/vibest-herdr` that imports herdr.                                                                                                                 |
| `packages/server`                                        | `server.ts`, `daemon.ts`.                                                                                                                                                                                                                                                             |
| `packages/client`                                        | `client.ts`. Depends on `schema` and `protocol` only.                                                                                                                                                                                                                                 |
| `apps/vibest-herdr` (`@vibest/cli`)                      | `cli.ts`, `main.ts` (provides `RuntimeHerdr.layer` as the daemon `Host.runtime`), `replace.ts`, `platform/`, `bin/vibest.cjs`, the build script, and the omac CLI tests.                                                                                                              |
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
- **`acceptance`** records each acceptance check of the Run's work and whether it passed: `{ reviewer, outcome (pass \| fail), summary, time }` (a test
  command, a reviewer's opinion). It explains why a Run ended the way it did.
- **Conversations.** The main Agent has one active conversation per Project; `vibest --new` starts another and
  keeps the earlier ones (their CLI session ids) so they can be resumed. Knowledge belongs to the Project, so
  every conversation and every subagent sees the same instructions and memory.
- **Project knowledge** (omac's Project store, copied): `instructions.md`, `memory/`, `docs/` written only by
  the main Agent through `vibest knowledge write --if-version`, with secret scanning; `scratch/` shared by every
  Agent of the Project. Instructions and memory are added to every subagent's rules (16,000 characters each).
  A subagent's `## Remember` section is a proposal the main Agent may write to memory.
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

- `once`: the Agent ends `completed` when its answer reports `completed`, that result was delivered to the main
  Agent, no Message for it is pending, and it is still idle (omac `--archive-on-completion`); a `failed` or
  `needs_input` answer keeps it. Ending closes the pane and releases its Workspace (§3.3).
- `kept`: when the Agent answers, it stays `idle` with its pane open. `vibest send` continues the conversation,
  and every new answer returns to the main Agent. `vibest stop <agent>` ends it, closes the pane, and releases
  its Workspace.

**Idle:** vibest does not model the CLI agent's internal loop. herdr's `idle` is the status. A piece of work ends
when its integration reports the end of its work (Claude `Stop`, Pi `agent_settled`, …) and its inbox is empty;
that is when `agent.idle` runs and the next Message is delivered. For a harness with an integration, herdr reporting idle with no hook result for
10 s makes the Message `lost` (a reason and the `vibest peek <id>` command, never screen text; the last 30 lines go to vibestd.log); only a harness without an integration treats
herdr's idle as the end.

**Outcome of a task or message** (omac's turn states, copied): a Message vibest delivered is `completed` or
`failed` by its result, `lost` as above, `not_started` when delivery could not be confirmed (§3.2), `interrupted`
by `vibest interrupt`. Text the user types into a subagent's pane is recorded as its own round and
opens no such Message; when that turn ends, the user's text and the subagent's answer go to the main Agent as one
`notice` (information, delivered with its next input, never a task it must act on).

**Results** come through the best channel (D11): the integration writes the agent's last answer to
`results/<agent>.json` and then notifies the daemon (Claude `last_assistant_message`, Cursor and Pi `text`); a result counts only if newer than the delivered Message. `vibest report "…"` sends progress, or with
`--json` a structured result validated against the requested schema; `herdr agent read` is last.

The subagent's rules ask for a final reply with `status: completed | failed | needs_input`, `summary:`, the body,
and an optional `## Remember` (omac `results.ts`). The main Agent receives (omac `results.ts`, `sessions.ts`):

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
- **Into the main Agent** natively where the CLI allows it: the Claude plugin's inbox module (attach, pull, ack,
  release with a generation and a claim token; claim file 0600, at most 4 MiB; `/vibest-reattach` is the only
  replace) and the Pi extension's subscription stream. Otherwise typed through herdr `agent.prompt`. No main
  Agent pane: Messages are `dropped`.
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
- Decision points (`agent.idle`, `agent.fail`, `run.end`) are recorded before their hook runs;
  after a restart an unfinished decision runs again, so plugin decisions must be idempotent.

### 3.3 Ending and cleanup

Copied from omac `remove.ts`, `processes.ts`, `worktree.ts`. `vibest interrupt <agent>` sends the adapter's
interrupt key and waits 10 s for idle; the Agent and pane stay. `vibest stop <agent>`:

1. interrupts if working, records a tombstone, and fails its pending Messages with one notice;
2. records the pane's shell and foreground PIDs, then closes the pane; if the pane is the last one of a main
   checkout's workspace, it is first moved alone into a new workspace, because closing it would close the
   whole herdr worktree group;
3. proves exit with signal 0 (every 100 ms, 30 times); `alive` or `unknown` keeps everything and a later
   `vibest stop` checks again;
4. removes a Workspace made for this Agent only when it is a listed worktree, no pane or process (lsof cwd scan)
   is inside it, `git status` is clean, and HEAD is on a branch or remote ref; `git worktree remove` without
   force; branches are never deleted.

Rows are never deleted. `vibest ls` lists Agents that have not exited; `vibest ls --all` and `vibest result <id>` still show an exited one.

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
  so subagents never nest. Run from a plain terminal,
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
  destructive git or file actions need the user's quoted consent; never control herdr; shared files go to
  scratch prefixed with the Agent id; the final reply format of §3.1.

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

A rule is an ordinary plugin on one hook (§7). The builtin `check` rule: on `agent.idle` of a writing subagent
it runs the configured command in that Agent's Workspace; on failure it sets `event.prompt` to the output, so
the same Agent continues instead of going idle; after the last attempt it lets the Agent go idle with the
failure in its result. One acceptance entry per attempt. Configuration, per Project:

```jsonc
// ~/work/shop/vibest.jsonc
{ "plugins": [{ "package": "check", "options": { "command": "pnpm test", "attempts": 3 } }] }
```

Rule state lives in `storage` and decisions are idempotent, because decision hooks run again after a restart.

## 5. Service composition

- Services are `Context.Service` classes; each module exports itself as a namespace
  (`export * as Run from "./run.js"`).
- Services are assembled from a **service graph**: each entry is `{ service, layer, dependencies }` with a scope.
  A narrower scope may depend on a wider one, never the reverse, checked at type level. The graph compiles to
  one `Layer`.
- Configuration replaces entries at the composition root (`Database.entry.replace(Database.configured(...))`).
  Product identity and runtime are replacements, which is how one core yields several isolated products.

| Scope       | Lives                                                               | Holds                                                                                                                    |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **daemon**  | once per daemon                                                     | Product, Database, Event bus, Project registry, Machine registry, Run and Agent execution, Scheduler queue, event stream |
| **project** | one compiled graph per Project, in a `LayerMap` keyed by Project id | Configuration, catalogs (definitions, harnesses, skills, Workspace types, commands), plugin registry and supervisor      |

## 6. Persistence and events

Copied from omac `db.ts`, on the four tables of `schema.md`:

- SQLite, WAL, STRICT tables, foreign keys on, all SQL in one service. The database carries an
  `application_id` and a `user_version`; a file that is not vibest's, or not this version, is refused before any
  writable open (`SchemaMismatch`), leaving it untouched. Migrations start with the first release.
- Tables `project`, `session` (one row per Agent run: one CLI process in one pane), `inbox` (delivery), `message`
  (each turn and its answer; the open turn has no `ended_at`) in `docs/design/schema.md` are the state, changed in
  transactions. Run is `session.run`, Workspace is `session.cwd`, the conversation is the Project's `main_session`
  row. An Agent's status is live from the runtime (memory only); its task is its first `task` inbox row. Events are kept in
  memory and logs (no `event` table until replay is needed). Rows are never deleted.
- Files keep one writer each and are written to a temporary file and renamed (omac write model): result files
  by the harness plugins, rules files by the daemon; never the user's harness configuration.
- Not stored: worktree branches and dirty state (asked from git), herdr panes and states (asked from herdr).

## 7. Plugin architecture (Effect only)

**Definition:**

```ts
export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}
export const define = <R = Scope.Scope>(plugin: Plugin<R>) => plugin
```

**Three capabilities:** scoped `Registration`s with `dispose`; `transform(editor)` with a synchronous editor plus
`reload()` for catalog domains; `hook(name, callback)` for runtime interception. Every domain extends the
matching client API interface and adds only plugin-specific members.

**Context domains:**

| Domain         | Client API (`Pick` of)                                 | `transform` / `reload` | `hook`                         |
| -------------- | ------------------------------------------------------ | ---------------------- | ------------------------------ |
| `project`      | get                                                    | —                      | —                              |
| `workspace`    | list, create, release                                  | yes (types)            | —                              |
| `definition`   | list, get                                              | yes                    | —                              |
| `harness`      | list                                                   | yes                    | —                              |
| `run`          | get, list, stop, record acceptance                     | —                      | `create`, `end`                |
| `agent`        | —                                                      | —                      | `start.before`, `fail`, `idle` |
| `subscription` | list (via `report`)                                    | —                      | —                              |
| `machine`      | list                                                   | yes                    | —                              |
| `command`      | list                                                   | yes                    | —                              |
| `skill`        | list                                                   | yes                    | —                              |
| `event`        | `subscribe({ types })` → `Stream`                      | —                      | —                              |
| `rpc`          | `register(definition, handlers)`, `client(definition)` | —                      | —                              |
| `storage`      | `get`, `set`, `remove`, `scan` (namespaced per plugin) | —                      | —                              |

**Agent hooks** (OpenCode V2 semantics, one hook domain: `context.agent.hook("start.before" | "fail" | "idle", ...)`):

| Hook                 | Event (writable fields)                                                                                                      | Runs                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `agent.start.before` | `prompt`, `harness`, `provider`, `model`; read-only: project, agentType, parentSessionId, harnesses, subscriptions, attempts | before every Agent starts, the main Agent included                                       |
| `agent.fail`         | `move` (`{ harness, provider?, model? }                                                                                      | undefined`); read-only: sessionId, reason, error, turn, harness, provider, attempts, ... | a started Agent's round failed (today a usage limit) |
| `agent.idle`         | `prompt`, `command`, `output`; read-only: sessionId, agentType, directory, answer, checkAttempts, ran                        | the subagent's round would otherwise go to its parent                                    |

Every event carries the Project, the caller, the current Subscriptions, and the earlier tries. Callbacks run
sequentially in plugin order and mutate the one event in place - no per-callback copy - so a later plugin sees
(and may overwrite) what an earlier one wrote; the trace attributes each changed field to the plugin that wrote
it last. Only `agent.start.before` may refuse: `Effect.fail(new AgentRefused({ reason }))` stops the chain at
once, nothing is inserted and nothing starts; a defect or a timeout there is also a refusal (`plugin <id>
crashed: ...`, `plugin <id> timed out after 5s`), and the caller sees the plugin id and the reason. On
`agent.fail` and `agent.idle` an `AgentRefused` counts as a crash: a crash or a timeout fails that operation
(an `agent.fail` crash leaves the round failed with the plugin error, no move; an `agent.idle` crash delivers
the round failed with the plugin error). Nothing is skipped silently.

**The builtin default harness choice** (id `harness-choice`, always first, before user plugins): left alone, a
caller's usable harness preference stands (and a free login is picked when the provider is unset); anything
else is routed to the available harness with the most quota left, and a start with no harness any plugin could
run is refused naming each harness's problem. On `agent.fail` with reason `limited` and `move` still unset, it
moves to the best harness that is neither limited nor already tried.

**Counters and traces** (omac `plugins.ts`): per plugin and hook, calls, changes, crashes, timeouts, refusals,
and the last error, shown by `vibest plugins`; every trace entry is `{ plugin, hook, ms, outcome:
"ok" | "refused" | "crashed" | "timeout", changes }`, a diff against the event before that callback.

**Dispatch:** sequential in plugin order; one mutable event object passes through every callback; every
callback is bounded by a 5 s timeout (waiting on its fiber, so an uninterruptible region still returns on
time).

**Registry and supervisor:** identity `(id, revision)`; reactivation keeps the longest unchanged prefix and
rebuilds the rest in order inside a batch; a failing new revision falls back to the previous one and is not
retried until it changes; an activation latch gates entry points; triggers are configuration changes, module
file changes, and a daily update tick, debounced by 100 ms; npm plugins install into the vibest home and
activate after local ones.

**Order:**

```
builtin plugins         harness adapters, default definitions, Workspace types,
                        scheduling, guard, knowledge, skills, check
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
loads vibest's plugin into the CLI so its work comes back as events (integration side). The Harness contract lives in
`schema`; `plugin-harnesses` implements Claude Code, Cursor, and Pi. Each CLI runs as installed on
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
| Availability   | the CLI on PATH, login valid, its model list (cached 5 minutes); feeds the builtin harness choice                  | none                                |
| Read-only      | arguments that keep the CLI from editing files (plan or read-only sandbox modes)                                   | the instruction "do not edit files" |
| Interrupt      | keys that stop the agent's current work                                                                            | `Escape`                            |

**Integration side: plugins loaded at launch, never installed.** vibest's plugin for each harness ships with the binary
(`harnesses/<harness>`, `scripts/build-harnesses.ts`): in each release archive beside `bin/vibest`, and in the
`@vibest/cli` npm package, whose platform packages hold only the binary. `bin/vibest.cjs` hands the npm directory to the
binary as `VIBEST_HARNESSES`; without it the compiled binary looks beside its own directory (`<root>/bin/vibest`,
`<root>/harnesses`, the link resolved), which is how install.sh's install runs, without Node. The adapter loads the plugin into
each session it starts, and into the main Agent: Pi `-e <dir>/extension.mjs`, Claude Code and Cursor `--plugin-dir <dir>`.
Each of these adds to what the harness loads; the user's own plugins, extensions and hooks keep loading beside it
(checked against Pi 1.4, Claude Code 2.1.316 and cursor-agent 2026.10.22). Why not install into the harness's config:

- scope: an installed plugin runs in every session of the user, not only vibest's (a fail-closed guard of a broken
  vibest would block the user's own Cursor);
- version: the plugin always matches the binary it ships with; there is no `outdated` state, update step or marketplace;
- no writes to the user's config, so no diff, backup or uninstall leftovers; Cursor's marketplace is account-level and
  cannot be installed into locally at all.

The cost: a harness started by hand does not load it, which is the intent. vibest never writes into a harness's config. `preflight` refuses a harness whose plugin directory is missing.

| vibest event                   | Claude Code              | Cursor                       | Pi                              |
| ------------------------------ | ------------------------ | ---------------------------- | ------------------------------- |
| `agent.session`                | `SessionStart`           | to verify                    | `session_start`                 |
| `agent.prompt`                 | `prompt.submit` (origin) | `beforeSubmitPrompt`         | `agent_start`                   |
| `agent.tool`                   | `tool.call`              | `preToolUse`                 | `tool_call`, `tool_execution_*` |
| `agent.idle` with last answer  | `turn.complete` (answer) | `afterAgentResponse`, `stop` | `agent_end`, `agent_settled`    |
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

**Nested conversations are filtered** (omac `integration.ts`): events carrying `agent_id` (the CLI's own
subagents), and Cursor events whose `CURSOR_CONVERSATION_ID` differs from the conversation's, are ignored.

`capabilities` are visible to the harness-choice hooks (for example, only harnesses that can resume may
continue a limited Agent in place).

## 9. Harness choice

Which harness an Agent runs on is one decision, made by the `agent.start.before` chain (§7): the builtin default
first, then every user plugin in order, each able to keep or overwrite what came before. vibestd validates the
final harness (it exists, its plugin directory is there, its model list reads, the model is offered) and
refuses a start that never settled on one.

A usage limit is the same decision in reverse, on `agent.fail`: the round that failed stays the round that
finishes, and the session restarts — same id, same worktree, same task (the open round's input, else the text
the launch was about to send, else the trailing delivered batch) — on the harness the chain writes into
`event.move`. Before each candidate starts, the move runs the `agent.start.before` chain with the move's
harness/provider/model and the session's real attempts prefilled: a refusal skips that candidate (recorded as a
`refused` try), and what the chain decides — including a rewritten harness or prompt — is what gets patched and
started, so a start policy plugin governs a moved Agent exactly like a first start. The builtin default moves to
the available harness with the most quota left that is neither limited nor already tried; nothing left ends the
round failed, naming what ran out. The pairs that already hit a limit are remembered per (harness, provider) in
`session.metadata.attempts`, so they survive moves and a vibestd restart; a preflight miss, or a start or prompt
that fails, is not a limit — the next move may use that harness again. A login already limited before start is
`agent.start.before`'s to avoid (the builtin does), never a move's.

## 10. Ports

| Port                                                         | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Herdr implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime** (`@vibest/plugin` `Runtime`, runtime-port.md §3) | one `Runtime` interface a plugin registers (`context.runtime.register`, beside `agent.hook`): required `kind`, `status(machine)`, and on terminals `open` (argv exactly, env, label, `near?`, `split?`, `focus?`), `send` (text/keys), `read`, `process`, `close`; optional `state`, `session`, `events` (`exited`/`state`/`reset`), `exec`, `present` (labels and tokens), `prepare`, `attach`. One error type `RuntimeError { code }` (`not_found`\|`busy`\|`unreachable`\|`incompatible`\|`failed`); `Terminal { machine, id }` stored on the Agent row, opaque to core. Core uses only required members plus optional ones when present, with the §3 fallbacks (no `events` → poll `process`; no `exec` → hidden terminal; no `present` → `open`'s label; no `state` → the harness integration's report lines and OSC 7501 only). Shared contract suite: `@vibest/plugin/testing` `runtimeContract`, run against a real local instance. Choice (§4): the parent's runtime, else the configured `runtime` (vibest.json's top-level `runtime` key), else herdr among online, else the only one online; machine is always `local` this phase | `packages/runtime-herdr/src/terminal-runtime.ts` (`fromPool`, `KIND = "herdr"`): terminal id `<session>/<pane id>`; `Machine.target` is the caller's herdr location as JSON. `open` = `tab.create` (env only settable there) in the Project's workspace (`worktree.list` group, else a pane at the root, else `workspace.create`) plus `agent.start` for a harness argv (retried on `agent_pane_busy`; anything else typed into the pane's shell as `exec`, undone with `tab.close` when the start inside it dies); `send` → `agent.prompt`/`agent.send_keys` targeted by the agent name `open` gave (a reused pane id reads `agent_not_found`), else `pane.send_text`/`send_keys`; `read` → `pane.read`; `process` → `pane.process_info` (running = a foreground process besides the shell); `close` → the agent-identity check (the name `open` gave still in that pane), then `pane.move` (alone, so a main checkout's group survives) + `pane.close`; `state` → `agent.get` (`interactive_ready`, `done`→`idle`); `events` from the pool's broadcasts (`pane_closed`/`pane_exited` → `exited`, restart → `reset` plus re-subscribing every pane) plus per-pane `pane.agent_status_changed` → `state`; `present` → `pane.report_metadata`/`workspace.report_metadata` (source `vibest`, tokens ≤ 80 chars); `attach` → `herdr session attach`. No `exec` (hidden-terminal fallback). Loaded as the builtin `runtime-herdr` plugin (`plugin.ts`), beside `agent.hook` |
| **Harness**                                                  | §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `plugin-harnesses`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Workspace type**                                           | create and release a directory for a Project on a machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | builtin `root`; `plugin-git` adds `isolated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Product**                                                  | name, home, socket, environment prefix, executable name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| herdr connection                                             | one client per herdr session (current session inside herdr, a named headless session started by vibest outside it), protocol pinned in `effect-herdr-sdk` and checked by `ping` on every connect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `packages/runtime-herdr/src/pool.ts` (omac `herdr-pool.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **MachineTransport**                                         | reach a machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | the runtime plugin's connection (`runtime-port.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 11. Herdr TUI surface

The Herdr TUI product makes vibest usable inside herdr through herdr's own extension points (herdr 0.9.5).

- **herdr plugin** in `apps/vibest-herdr` (`herdr-plugin.toml`). Every entrypoint runs `vibest <command>` and
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
vibest knowledge info | list | read | search | write --if-version | delete      Project knowledge
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
`IncompatibleDaemon` on a mismatch; the package version is informational. Scoped methods need caller headers
(`user` with a Project directory, or `agent` with `VIBEST_AGENT_ID`); the role comes from the stored row, and
missing or mixed headers are `InvalidCaller`, never the user. The ACCESS table lists every method, checked at
compile time: open (integration notifications), subagent (`Report`), main Agent or user (`Run`, `Send`,
`Interrupt`, `Stop`, …, only on Runs of its Project), user only (daemon, update). Socket mode 0600 is
the authentication; roles prevent mistakes, not attackers.

**Daemon** (omac `daemon.ts`, `drain.ts`, `replace.ts`, copied): a start lock held by an exclusive SQLite
transaction; a socket that answers is never unlinked; the instance (pid, start id, argv) is in Ping and
`vibestd.pid`; only the user's command starts the daemon, never an agent's (it would inherit the agent's
sandbox). `daemon restart` and `update` replace it only after `y` on a terminal, while agents keep running: the old
one refuses new changes with `DaemonStopping`, drains its own operations (admitted requests, deliveries, launches,
archives; `core/drain.ts`) for up to 5 s, and leaves pending Messages in sqlite for the next one.

**Distribution** (omac `bin/`, `cli-<platform>` packages, `build-flags.ts`): two installs of the same compiled binary,
built without `bunfig` and `.env` autoloading. install.sh (`curl … | sh`) downloads this platform's archive from the
latest GitHub Release (a `v*` tag's release: one archive per platform, install.sh, and `version`), unpacks it to
`~/.local/share/vibest/versions/<version>/` and links `~/.local/bin/vibest` to it; it keeps the version before as well, for a
vibestd and sessions still running it. npm (`npm i -g @vibest/cli@beta`): a Node launcher runs the platform package's
binary. `vibest update` updates the way vibest was installed: install.sh again into the same directories, or the package
manager; a build or source checkout is refused. The install never lives under `~/.vibest`, which holds data only.

## 14. Home layout

`~/.vibest` already holds data from an earlier project (`logs/`, `pty/`, `storage/`); vibest never touches
those. The vibest install itself is not here: install.sh puts it in `~/.local` (§13, Distribution), npm in its prefix. Its own entries:

```
~/.vibest/                   (VIBEST_HOME overrides)
  vibest.jsonc  vibest.db  vibest.sock  vibestd.pid  vibestd.log
  definitions/  skills/  plugins/  packages/
  results/<agent>.json       written by integrations
  rules/<agent>.md           written by the daemon
  inbox-claims/              claim files of the Claude inbox
  projects/<project>/        knowledge (instructions.md, memory/, docs/) and scratch/
  worktrees/<repository>/<name>/   isolated Workspaces (omac naming, `.worktreeinclude` copied)
```

## 15. Copied from omac and refactored (D12)

Source paths are in `iamdin/pi-orchestrator` (`packages/cli/src` unless shown). The omac tests named come along
and are the acceptance for each part.

| Part                                       | omac source                                                                                                   | Refactor                                                                        | omac tests                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| herdr client                               | `packages/effect-herdr-sdk`                                                                                   | regenerate for herdr 0.9.5, pin its protocol                                    | —                                                                                                          |
| herdr connections                          | `herdr-pool.ts`                                                                                               | moved to `runtime-herdr/pool.ts`                                                | `live.test.ts`                                                                                             |
| Protocol, caller, ACCESS, admission        | `rpc.ts`, `protocol.ts`, `server.ts`, `client.ts`                                                             | methods for Run, Agent, Message, knowledge; roles main / subagent / user / open | `rpc.test.ts`, `cli.test.ts`                                                                               |
| Daemon lock, instance, replacement, update | `daemon.ts`, `core/drain.ts`, `replace.ts`, `cli.ts`                                                          | blockers are unfinished daemon operations, never Agents                         | `daemon.test.ts`, `stop.test.ts`, `update.test.ts`                                                         |
| Distribution                               | `packages/cli/bin`, `packages/cli-*`, `build-flags.ts`, `scripts/build.ts`                                    | names                                                                           | `launcher.test.ts`, `release-smoke.test.ts`                                                                |
| Database                                   | `db.ts`, `platform/bun.ts`                                                                                    | tables of §6                                                                    | `unit.test.ts`                                                                                             |
| Starting an Agent                          | `sessions.ts` (spawn), `worktree.ts`, `harness.ts` + `harnesses/*.ts` (the adapters, provided as `Harnesses`) | session → Agent in a Run; Workspace types                                       | `sessions.test.ts`, `worktree-group.test.ts`                                                               |
| Delivery and outcomes                      | `sessions.ts` (prompt, turns), `inbox.ts`                                                                     | turn state → Message `outcome`; coordinator → main Agent                        | `sessions.test.ts`, `self-heal.test.ts`                                                                    |
| Results                                    | `results.ts`                                                                                                  | add Run id                                                                      | `unit.test.ts`                                                                                             |
| Interrupt and stop                         | `sessions.ts`, `remove.ts`, `processes.ts`                                                                    | archive → `stop`; `--archive-on-completion` → `once`                            | `remove.test.ts`, `stop-coordinator.test.ts`                                                               |
| Main Agent launch and resume               | `launch.ts`, `sessions.ts`, `server.ts`                                                                       | coordinator → main Agent of a Project                                           | `stop-coordinator.test.ts`                                                                                 |
| Rules                                      | `rules.ts`                                                                                                    | subagent rules; main Agent rules become builtin skills                          | `unit.test.ts`                                                                                             |
| Knowledge                                  | `project.ts`                                                                                                  | repository key → Project id                                                     | `project.test.ts`                                                                                          |
| Models                                     | `models.ts`                                                                                                   | Availability capability                                                         | `unit.test.ts`                                                                                             |
| Integrations                               | `integration.ts`, `packages/claude`, `claude-inbox.ts`, `packages/pi-omac`                                    | forward the §8 events; agent instead of session                                 | `integration.test.ts`, `claude-inbox-*.test.ts`, `claude-integration-stop.test.ts`, `cursor-allow.test.ts` |
| Guard                                      | `guard.ts`                                                                                                    | `plugin-guard` on `agent.tool`; roles main / subagent                           | `guard.test.ts`                                                                                            |
| Plugin loading                             | `plugins.ts`, `plugin-sources.ts`, `platform/plugin-source.ts`                                                | V2 API and the §7 kinds; keep counters, traces, reload                          | `plugins.test.ts`, `plugin-reload.test.ts`, `plugin-binary.test.ts`                                        |
| Test fakes                                 | `packages/cli/test/fakes.ts`                                                                                  | fake herdr Layer for the new services                                           | —                                                                                                          |

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

| vibest                                          | Pattern                                                                                                         | Source                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain in core, implementation in plugins (D2)  | schema contracts with internal plugins implementing them                                                        | `packages/schema/src/goal.ts` with `packages/core/src/plugin/goal.ts`; `packages/schema/src/provider.ts` with `packages/core/src/plugin/provider/` |
| Package layering (§2)                           | one-way runtime dependencies; client never imports core or server                                               | `AGENTS.md:2`, `packages/schema/AGENTS.md`                                                                                                         |
| Result to parent (§3.1)                         | a subagent result wakes its parent                                                                              | `SessionIdleBackground` in `packages/plugin/src/effect/session.ts`                                                                                 |
| Service graph and scopes (§5)                   | typed dependency graph over Layers, scope tags, replacement-based configuration                                 | `packages/util/src/effect/layer-node.ts`, `app-node.ts`, `packages/server/src/routes.ts:118-150`                                                   |
| Per-Project graph (§5)                          | one compiled graph per key in a `LayerMap`, evicted on failure                                                  | `packages/core/src/instance.ts`, `location-service-map.ts`, `instance/service.ts`                                                                  |
| Plugin API (§7)                                 | `Plugin.define`, `Registration`, `transform` / `reload`, `hook`, domains as `Pick`s of client APIs              | `packages/plugin/src/effect/plugin.ts`, `registration.ts`, `packages/plugin/AGENTS.md`                                                             |
| Catalog state (§7)                              | synchronous editors replayed in registration order, batched change notification                                 | `packages/core/src/state.ts`, `packages/plugin/src/effect/provider.ts`                                                                             |
| Hook dispatch (§7)                              | sequential, single mutable event, decision fields, no timeout (transform, refuse, decision)                     | `packages/core/src/plugin/hooks.ts`                                                                                                                |
| `agent.idle`, `agent.fail`, `agent.prompt` (§7) | idle hook admitting input, retry decision, prompt rewrite                                                       | `experimental.idle`, `retry`, `prompt` in `packages/plugin/src/effect/session.ts`                                                                  |
| Registry, supervisor, order (§7)                | `(id, revision)`, prefix reactivation, fallback, latch, builtin / user / configuration order                    | `packages/core/src/plugin.ts`, `plugin/supervisor.ts:152-162`, `plugin/internal.ts`                                                                |
| AgentDefinition (§3)                            | definition with `mode`                                                                                          | `packages/schema/src/agent.ts`                                                                                                                     |
| Subscription limits (§3)                        | per-window meter (V2: `{ percent, limited, resetsAt }`)                                                         | `packages/schema/src/usage-limits.ts`                                                                                                              |
| IDs (§3)                                        | prefixed branded IDs with sortable bodies and `create()`                                                        | `packages/schema/src/identifier.ts`, `session-id.ts`                                                                                               |
| Global and project configuration (§7)           | global directory, then project files found walking up from the working directory                                | `packages/core/src/config/discovery.ts`                                                                                                            |
| Plugin entries (§7)                             | ordered `plugins` directives: name, path, `{ package, options }`, `-id` to remove; options on `context.options` | `packages/schema/src/config/plugin.ts`, `packages/core/src/config/plugin/source.ts`, `packages/plugin/src/effect/plugin.ts`                        |
| Configuration through plugins (§7)              | configuration files projected into catalogs by builtin plugins                                                  | `packages/core/src/config/plugin/agent.ts`                                                                                                         |

Where vibest differs: protocol, persistence, delivery, and daemon come from omac (§15), not from OpenCode;
graphs are per Project, not per directory; decision points survive restarts; notify hooks have a timeout; no
coding-agent domain; harness adapters sit on top of an external runtime (herdr).
