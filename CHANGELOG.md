# Changelog

Every vibest API is experimental until it is declared stable (`.agents/rules/api-stability.md`): it may change in any
release. Each release lists what broke, who is affected and how to migrate under "Breaking changes".

## Unreleased

### Breaking changes

- **Agent hooks change the event instead of returning a decision** (plugin authors): `agent.hook("start.before" | "fail", callback)`
  callbacks return nothing (`Effect<void, …>`, Promise `void`) and assign to the event (their own deep copy of it): `start.before` events have
  mutable `prompt`, `harness`, `provider`, `model`, `machine` and `runtime`; `fail` events have a mutable `move`.
  `AgentRoute` and `AgentResults` are gone. Each callback works on its own deep copy and the host copies the changed fields
  back (deep-copied again) only when it succeeded within its 5 s deadline, so a timeout or failure changes nothing. Migrate
  `Effect.succeed({ harness: "pi" })` to `Effect.sync(() => { event.harness = "pi" })` and a returned move to
  `event.move = { harness, … }`. Machine hooks still return notes.
- **A start while plugins are still loading is refused** (users; RPC clients of `Spawn`, `Launch`,
  `Project.StartEntry` and `Peer.Spawn`): `agent.start.before` and `agent.fail` wait up to 10 s for plugin
  activation and then fail with `PluginsNotActive`, naming the plugins still loading, instead of running with only
  the plugins already active. Retry once `vibest plugins` shows them active. `vibest plugins` no longer waits
  for activation; it lists the plugins that are active when it is called.
- **Plugin API members without a caller removed** (plugin authors): `context.runtime.reload` and `context.harness.reload` (`Definitions.reload` of the Promise entry) are gone; the editors of `agent.transform`, `runtime.transform` and `harness.transform` no longer have `list`, `get` and `remove`, the agent and runtime editors no longer have `update` (the editors are `add`, plus `update` on the harness editor; a registration's `dispose` removes what a transform added); `Fact`, `FactOf` and `FactType` are no longer re-exported from either entry (import them from `@vibest/schema/event`); `Harness.LaunchInput` is no longer exported (use `Parameters<HarnessDefinition["launchArgs"]>[0]`). `@vibest/plugin/testing` no longer re-exports `RuntimeDefinition` (import it from `@vibest/plugin/effect` as `Runtime.RuntimeDefinition`) and no longer exports `ContractError`, `ContractFailure` and `ContractOptions`. No longer exported from the entries: `AgentContext`, `MachineRuntime`, `MachineRuntimeThere`, `StartupPane`, `HarnessEvent`, `CallerValues`, `CaptureOptions`, `SubscriptionDomain` (Effect) and `Cleanup`, `Definitions` (Promise). They return when a caller needs them.
- **Plugin entry points split into Promise and Effect** (plugin authors): `@vibest/plugin` is now the Promise API only
  (`Plugin.define({ id, setup })`, a Promise `Context`) and `@vibest/plugin/effect` is the Effect API
  (`Plugin.define({ id, effect })`, `Context`, `Hooks`, `Registration`, `Transform`, `Runtime`, `Harness`, `capture`,
  `reconnectSchedule`). `Plugin.define` takes one shape per entry; `Plugin.Plugin` is no longer a union and
  `Plugin.effectOf` is gone (the host picks the form itself; `@vibest/plugin/promise/adapter` exports the Promise adapter `fromPromise`). `PromiseContext`, `PromiseRegistration` and `PromiseDefinitions`
  are now `Plugin.Context`, `Registration` and `Definitions` of the Promise entry. `Subscription`, `SubscriptionAccount` and `SubscriptionLimit` are no longer exported from either entry: import them from `@vibest/schema/subscription`. `@vibest/plugin/testing` `machineHooks` accepts only Effect plugins (a Promise plugin throws `TypeError: plugin.effect is not a function`); migrate `machineHooks(plugin)` to `machineHooks({ id: plugin.id, effect: fromPromise(plugin) })` with `fromPromise` from `@vibest/plugin/promise/adapter`. Migrate: an Effect plugin changes
  `from "@vibest/plugin"` to `from "@vibest/plugin/effect"`; a Promise plugin keeps its import.
- **A `vibest.json` plugin entry must be a folder** (plugin authors, users with single-file entries): an entry that names
  a file is skipped with a warning, as OpenCode does. Put the file in `~/.vibest/plugins/`, or move it to a folder with
  an `index.ts` (or a `package.json` with `exports`) and name the folder. The shipped Cursor plugin is now
  `harnesses/cursor/index.js`; name the folder `harnesses/cursor`.
- **`Send` takes a UUID `request`** (RPC clients): the optional `request` field of `Send` must be a v4 UUID and any
  other value is refused when the request is decoded. A retried `Send` with the same `request` reaches another
  machine once. Send a fresh `crypto.randomUUID()` per message and reuse it only when retrying that message.
- **`vibest ls` git when a worktree is missing** (scripts reading session JSON): a missing worktree used to give
  `git: null`, and the list did not fail. That row now has a `git` object with `unknown` set (`git cannot read it`
  when the folder is gone; the error text when inspection throws). Check `unknown` before reading `saved`: `saved` is
  false, which is not unsaved work. A readable session's `git` has no `unknown`. A thrown inspection no longer fails
  the whole list; the other rows stay as they were.
- **`SubscriptionSnapshot` is `Subscription`** (plugin authors): `@vibest/plugin` no longer declares its own subscription types; `SubscriptionAccount` and `SubscriptionLimit` keep their names and `SubscriptionSnapshot` (the `subscriptions` of the agent hook context) is now `Subscription`, all re-exported from `@vibest/schema/subscription`.
- **Starting and stopping the entry session is user-only** (RPC clients, agents): `Launch`, `Project.StartEntry`,
  `Project.EntrySession` and `Project.StopEntry` refuse a session calling them, including the entry session itself.
  Ask the user to run these operations from a terminal that carries no agent session.
- **The read model is projection version 8** (anyone upgrading or reading `vibest.db`): `outbox` gains `recipient` so a
  message whose creator has ended reaches the nearest living creator, including on another machine. vibestd rebuilds
  the projection from a compatible event log on first start after upgrading; no manual step is needed for that rebuild.
  Databases with an older event-log shape are refused as described below.
- **`vibest run --peer` is `--share`** (agents and scripts that start a session in another session's worktree): the flag,
  the `Spawn` field `peer` and its refusal text are renamed; `peer` now names only another machine's vibestd.
- **Cursor is a plugin, claude is the default harness** (users of Cursor, and anyone relying on "no harness to
  inherit"): vibest comes with the Claude and Pi integrations only. To use Cursor add the
  folder `harnesses/cursor` of the install directory to `plugins` in `~/.vibest/vibest.json`; until then `--harness
  cursor` fails saying no plugin provides it, and a Cursor session cannot resume or restart. The first bare `vibest` in a project with no `--harness` and no plugin choosing now starts Claude when
  Claude is available. To choose differently write `"-harness-default"` in
  `plugins` and pick the harness in a plugin of your own.
- **`-<id>` removes builtin plugins** (plugin authors): an entry such as `"-runtime-choice"` now removes the builtin with
  that exact id; `"-*"` and `"-prefix.*"` still match only user plugins. Builtins are kept or removed from the config
  text at every activation, so un-removing one takes effect on the next reload without restarting vibestd.
- **Sessions run as agent definitions; no session is "main"** (users, plugin authors, anyone reading `vibest.db` or
  `vibest ls`): a definition (`{ id, description, system, guard? }`, registered by a plugin with `agent.transform`)
  decides a session's system prompt and its extra guard rules; the built-in ones are `coordinator` (what bare `vibest`
  opens as the entry session; it has no tool allowlist or MCP restriction any more, and file edits outside the project
  folder are refused by its guard) and `general` (what `vibest run` starts; `vibest run --agent <id>` picks another, and an
  unknown id is refused before any worktree or pane is made). `main` is gone as an agent value; the `start.before` field
  `agentType` is renamed `agent`; `VIBEST_AGENT` and the `vibest-agent` header are removed (the session id is the
  identity); `GuardCall.session` loses `workingDirectory` and `vibest`. Every session can run `vibest run`, `ls`,
  `project info` and the other agent commands; sends and management follow the creator rules below. Sessions started
  by a session record it as their parent. `vibest update` is for the user only. The Pi entry session appends the system
  prompt, every Claude session starts with all of Bash pre-approved (the coordinator had this before; subagents had
  only `vibest send`; permission rules the user sets to ask still apply), Cursor can run `coordinator` (its definition
  and session facts arrive in its first input), and the Pi extension serves every vibest session.
- **Messages carry who they are from; notices, ownership and sends fall back to the nearest living creator, not
  automatically to the entry session** (agents, users reading `vibest.db`, plugin authors): a message from a session
  reaches its reader wrapped in `<agent-message>` with the sender's id and title (this includes the task the session that started it gave it, and
  `vibest send` from a session); a notice from vibestd, and the instruction to continue after a restart, are wrapped in
  `<vibest-notice>`; text with no wrapper is the user's. The system prompt holds the definition's text, then the session
  facts (who started it, which working directory it has, what the wrappers mean), then a snapshot of `preferences.md`
  and the memory index. A session may interrupt, peek at or remove only sessions for which it is the nearest living
  creator. When a session's direct creator has ended, its notices, its sends to that creator and the right to manage it
  pass to the nearest creator above that is still running; with none, the user reads it with `vibest ls` and
  `vibest result` and nothing is delivered. A session may address sends only to its direct creator and direct children;
  sending to the entry session is no longer allowed to every session. A session started by another machine uses
  that machine's own harness choice (explicit flags, its plugins, its default), not the entry session's, and a harness
  that cannot run is refused with the list of harnesses the machine can run. A new session opens its pane beside its
  creator's. A session is not archived by `--archive-on-idle` while a session it started is running, and a session that
  has ended cannot start another. After `vibest update` each restarted session gets its own continue notice (the entry
  session no longer gets a project summary) and restarts are no longer ordered subagents first.
- **Pull or type depends only on the harness; the entry session is an ordinary session** (anyone reading
  `vibest.db` or `vibest ls`, harness integration and plugin authors): a harness that declares `inbox` (Claude, Pi)
  takes its next batch with `Inbox.Take` / `/inbox/take` when it is idle, for the entry session and spawned sessions
  alike; any other harness (Cursor) is typed into. vibestd does not hand out the next batch while an execution is open.
  A pulled batch is `delivered` and attached to its execution when it is taken, and the integration reports the
  execution accepted when the batch reaches the model; `/inbox/ack`, `Inbox.Ack`, the poll leases and the away timer
  are gone, `Inbox.Subscribe` only wakes the session, and its access level is `session`. Entry executions are recorded
  like any other (an entry execution can be judged `lost`), and `vibest ls` shows the entry as an ordinary row. A
  session with no creator (the entry session) does not switch harness on a usage limit. When Claude refuses the
  plugin's submit of a taken batch (it does after an Esc until someone types), the plugin reports the refusal for that
  execution and vibestd types the same batch into the pane, so the execution stays one and the batch is delivered once.
  A pulled batch is accepted only when the harness reports it (never from the runtime's working or blocked state), so a
  batch the harness never accepts ends `not_started` after the confirmation timeout whatever state the runtime
  reports. The fallback types only a batch this vibestd process itself handed over, once; a batch taken by an earlier
  vibestd is never typed, and ends `not_started` and fails its message with a notice after the confirmation timeout.
- **`vibest run` runs only inside a session** (users, scripts): a `vibest run` in a plain terminal is refused with a
  pointer to bare `vibest`, which opens a session. Every session `vibest run` starts, here or on another machine, records
  the session that ran it as its creator; `NoCallingSession` is the new error. Any session, not only the entry
  session, can now run `vibest run`.
- **An execution opens when its input is sent and is accepted once the harness takes it up** (anyone reading
  `vibest.db`, harness and runtime plugin authors): a send that never sees the harness ready leaves no execution (no
  `not_started` row); the catalog adds `execution.accepted` and an optional `failure.kind` (`limit`) on
  `execution.ended`, and the read model adds `execution.accepted_at` and `execution.failure_kind`.
  An execution end reported before its execution was accepted is ignored. vibestd starts each harness with
  `VIBEST_PROCESS` (its process id), integrations send it as the `vibest-process` header, and `Session.Ready` answers
  `{ process }`; an execution start or end from an earlier process of the session is dropped. A usage-limit move
  vibestd stopped part way through is finished by the next check, and sessions ended at a limit are checked at start.
  An older vibest cannot read a log that holds `execution.accepted`.
- **The coordinator and main-agent names become entry** (RPC clients, `vibest` JSON readers, harness integration
  authors): the project's entry session is what `vibest` opens in a terminal. RPCs `Project.CoordinatorSession`,
  `Project.StartMain`, `Project.MainPlace`, `Project.FocusCoordinator`, `Project.RunningCoordinator` and
  `Project.StopCoordinator` are `Project.EntrySession`, `Project.StartEntry`, `Project.EntryPlace`,
  `Project.FocusEntry`, `Project.RunningEntry` and `Project.StopEntry`; `CoordinatorSessionReady` is gone, the
  integration reports the conversation with `Session.Ready` and a new optional `conversation` `{ harness, id }`
  (ignored when `harness` is not the session's). The `Coordinator` caller shape is `Session`, like every other session.
  `Project.StartEntry` takes an optional `harness` and includes `LaunchFailed` in its error union. The entry session's
  `name` in `vibest ls` JSON is `entry` (was `main`), and errors that named the coordinator for the project's entry session
  say "entry session". The herdr action
  `open-main` is `open-entry` (rebind a key set to `vibest.open-main`), the runtime `present` info key `mainSession`
  is `entrySession`, and CLI help and errors say "entry session" where they said "main agent". A session whose agent
  is named `entry` is an ordinary session: the entry session is the one the project records.
- **Another machine's vibestd is told who made a call** (anyone running vibest on two machines, and RPC clients): a
  call forwarded as `<machine>/<id>` carries the header `vibest-peer-by` (`user` or the calling session's id), and the
  other vibestd refuses a forwarded call without it. Creator-based send and management permissions also apply on the
  other machine, and what a session sends is signed with its id. `Peer.Spawn` is run only by a session (`parent` and
  `reportTo` are no longer fields; the session in `vibest-peer-by` is the creator), so `vibest run --machine` outside a
  session is refused. What a session
  on the other machine sends to its creator arrives as a message (`<agent-message>` naming `<machine>/<id>`), not as a
  notice; `Peer.Outbox` items and the read model's `outbox.kind` distinguish `send` from `notice` (instead of `result`
  or `notice`).
- **Handoff database copies** (users): a handing-over vibestd no longer writes `vibest.db.before-<version>` (a copy of
  `vibest.db` and its `-wal`). Copies already in the home are left where they are. Copy the database yourself before
  `vibest update` if you want one.
- **The event log is per aggregate** (everyone upgrading, and anyone reading `vibest.db`): every fact belongs to one
  aggregate (a session, a project, or the file's ledger in `meta.ledger`) and is numbered within it; `event` has
  `position`, `aggregate`, `seq`, `at`, `type`, `data` and no `project_id` or `session_id`. The catalog is version 2:
  `turn.started`/`turn.ended` are `execution.started`/`execution.ended` (`turn` → `execution`, `status` → `outcome`),
  `turn.reported` is gone, `session.created` has `project` and `agent` (was `role`) and no `archiveOnCompletion` or
  `reportTo`, `origin.reportTo` is `origin.session`, `inbox.queued` has no `turn`, `inbox.moved` has `execution`,
  inbox kinds are `task`, `send` and `notice` only, `outbox.queued` names its `session` and has an optional `kind`
  (`send` or `notice`, `notice` when absent) and optional `recipient`, and `peer.seen` has no `callsMe`. The read model
  has table `execution` (`outcome`, `reply`) instead of `turn` (`status`, `answer`), `session.agent` instead of `role`,
  `session.origin_session` instead of `origin_report_to`, and no `session.turn_id` (a session's latest execution is its
  highest `execution.id`). `session.report_to_session_id`, `session.origin_parent`, `session.seq`, `project.seq`,
  `session.archive_on_completion` / `archive_on_idle`, `process.resume`, `process.ready_seq`, `inbox.queued_at`,
  `inbox.seq`, `inbox.result_turn_id`, `turn.report_seq` and `peer.calls_me` are gone. `process.conversation` starts as
  the conversation the process resumes. `process`, `execution` and `inbox` are keyed by `(session_id, id)`, with
  `inbox.session_id` (the recipient, never null) instead of `recipient_session_id` and `inbox.execution_id` instead of
  `turn_id` (a task with no `execution_id` was never handed over). `session.created` has no `origin.parent`.
  vibestd and `vibest daemon import-check` refuse a database in the old shape as one from an older vibest and change
  nothing in it; there is no automatic conversion. Migrate: with vibestd stopped, move `vibest.db` aside with its
  `-wal` and `-shm` files to start empty (the message gives the command).
- **turn is execution, and an execution's answer or result is its reply** (protocol 10: scripts reading CLI JSON,
  RPC clients, harness and runtime plugin authors): session rows in `vibest ls`, `vibest result` and Watch have
  `executionState` instead of `turnState`; `vibest result` (RPC `Get`) has `reply` instead of `result` / `answer`, and its
  `turn` is `execution`; a Watch session's `turn` is `finished`, and `Session.Seen` takes `{ id, finished }`. The
  RPC `TurnEnd` is `ExecutionEnd`, the hook route `/hooks/<harness>/turn-end` is `/hooks/<harness>/execution-end`,
  and the Claude plugin's end event is `ExecutionComplete`. A `HarnessDefinition` has `executionEnd` (returning
  `{ end }`, was `turnEnd` returning `{ result }`) and `replyField` (was `resultField`); a runtime's `Seen` has
  `finished` (was `turn`) and `see(terminal, finished)`; `agent.fail` gets the limited execution's `input` (was
  `turn`). Migrate: rename the fields; a vibest of another protocol is refused, so update every vibest together
  (`vibest update`, or `vibest daemon restart` after installing). The contract snapshot is regenerated.
- **`vibest run --archive-on-idle`** (users): the flag is no longer stored. A session started with it is still
  archived when it is idle after a completed execution, but only by the vibestd that started it: after a vibestd restart
  or `vibest update` it stays until archived by hand.
- **Execution ends** (anyone reading `vibest.db`, and anyone counting executions): an accepted execution's end is
  written at once as `execution.ended`, carrying its `reply` and any changed `conversation`, with no separate report
  fact. A usage limit ends its execution `failed` and the next harness gets the input in a new execution, so a limit
  move is two executions instead of one. A reply that arrives after vibestd gave an execution up as `lost` is an
  execution of its own. An execution stopped in its terminal (Esc) is `interrupted`, with no failure and no notice,
  like `vibest interrupt`.
- **Machine hooks return their notes** (plugin authors): `machine.connect`/`machine.remove` callbacks return their
  notes instead of pushing to `event.notes`; `MachineEvent` has no `notes`, and `@vibest/plugin/testing`
  `machineHooks().fire` takes an event without `notes`. Migrate `e.notes.push(n)` to `return [n]`.
- **Promise plugins** (plugin authors): a plugin may be `Plugin.define({ id, setup })` from `@vibest/plugin` instead of `{ id, effect }` from `@vibest/plugin/effect`:
  `setup` gets a context of Promises (hook callbacks return a value or a Promise and refuse by throwing
  `AgentRefused`, `event.subscribe` is an `AsyncIterable`) and may return a cleanup that runs when the plugin unloads.
- **Agent messaging** (users, plugin authors, anyone calling the RPC): an execution that ends normally or is
  interrupted sends nothing. Agents send what they decide to with `vibest send <id> -- '<message>'`, subject to the
  creator-routing rules above; `vibest ls` shows state and `vibest result <id>` reads the last reply. vibest sends
  notices only for what an agent cannot say: its harness exited, its execution ended in an error, it never started,
  it waits on a permission, or a message to it was not delivered. `vibest report`, the RPC `Report`,
  `SessionStatusInfo.result` and the `<agent-result>` message are removed. Migrate: replace `vibest report` with
  `vibest send` and use the renamed reply fields above.
- **The database** (users, and anyone reading `vibest.db`): vibestd stores an append-only log of facts and a read model
  projected from it, and applies schema migrations recorded in a `migration` table when it opens the file. It refuses
  a database in the pre-ledger shape (`SchemaMismatch`, the file unchanged): there is no automatic conversion; move it
  aside with its `-wal` and `-shm` files while vibestd is stopped to start empty. An older vibest cannot open the new
  file. Tools that read the tables directly must read the new ones (`docs/design/schema.md`): `process`, `execution` and the
  `event` log with the new fact types replace the old `event` rows (`process.start`, `turn.end`, `inbox.status`, …),
  and sessions have no `machine` column. `vibest daemon
  import-check` now replays the log and fails when the read model differs from the replay.
- **Runtime plugins** (plugin authors): plugins use `{ id, effect }` or `{ id, setup }`. `caller` moves from the plugin
  into the runtime definition, the runtime's `kind` is renamed `id`, and `context.runtime.register(runtime)` is replaced by
  `context.runtime.transform((editor) => editor.add(definition))`. The `Runtime` type is now `RuntimeDefinition`, and
  `RuntimeCaller` has no `kind` (the definition's `id` names it). An unchanged runtime plugin fails its setup and shows
  `failed` in `vibest plugins`. Migrate:

  ```ts
  export default Plugin.define({
    id: "my-runtime",
    effect: (ctx) =>
      ctx.runtime
        .transform((editor) =>
          editor.add({
            ...runtime,
            id: "mine",
            caller: { env: ["MINE_TERM"], terminal: (env) => Effect.succeed(env.MINE_TERM) },
          }),
        )
        .pipe(Effect.asVoid),
  })
  ```

- **Hook plugins** (plugin authors): `context.agent.hook` returns a `Registration` (`{ dispose }`) instead of `void`. A
  plugin that ignores the return value keeps working unchanged. `context.machine.hook` does the same and takes
  `{ runtime }`: a hook scoped to a runtime runs only when that runtime is the one being connected or repaired (an
  unscoped hook runs every time), replacing the old "only the plugin that registered the runtime" rule; `link` and
  `locate` are members of the runtime definition. A harness name in a plugin's own code is a plain
  `string` now, not a union of `pi`, `claude` and `cursor`.
- **`vibest run --machine` with herdr** (users): the agent opens in herdr's default session `default` on that machine
  (where its user's herdr TUI usually is), no longer in the session `vibest` or the one vibestd there was started in;
  vibestd starts that session when it is not running. A runtime's `open` gets `remote: true` for such an agent.
- **Runtime `locate`** (plugin authors): its second argument is a `ReadonlyMap` from session id to the terminal id the
  other machine reported for it, instead of an array of session ids, so a runtime can build its local id without
  asking the other machine. Migrate: read the session ids with `sessions.keys()` and the size with `sessions.size`.
- **`vibest run auto` is removed** (users, scripts, skills): for a local session, leave the harness out to inherit the
  calling session's harness, provider and model (`vibest run -- <prompt>`); name one to switch. Later bare `vibest`
  starts reuse the entry session's last harness. First starts and remote starts use the harness-choice rules above.
- **No quota-based harness choice** (users): the builtin `harness-choice` plugin and `@vibest/plugin-harness-choice`
  are removed. A named harness whose subscription is limited now starts and fails its execution when the limit hits; it is
  no longer refused or rerouted. A plugin on `agent.start.before` may still route by the subscriptions in the event.
- **`Harnesses.List`** (RPC clients, scripts reading it): takes an optional `{ provider }` and each row gains `binary`.
  The Ping capability `harnesses` is removed; the method is part of the protocol. New RPC `Integration.Guard`. Harness
  ids in every RPC are plain strings.

### Added

- `vibest harness ls --machine <name>` lists the harnesses of another machine, asked of that machine each time.

### Changed

- vibestd writes `vibestd.log` itself. When that file is over 10 MiB at startup it keeps the last 5 MiB, from the next line, and does not trim again until the next start. A foreground vibestd's standard output and error are this file.
- The entry session's row in `vibest ls` (and `--json`) now shows the git state of its directory and the repository
  root git reports for it, like any session working in that directory; it used to show no git state and its directory
  as the repository root.
- vibestd stops within 10 seconds (plus a 1.5 s log flush) when asked to stop by SIGTERM, SIGINT, a terminal hangup or
  `vibest daemon restart`, even if a layer such as a plugin teardown never finishes: it logs and prints the layers
  still releasing, with how long each has been, and exits; a second signal exits at once. The start and readiness waits
  of `vibest daemon` and `vibest daemon restart` grew from 10 s to 21.5 s so a replacement outlasts that deadline.
