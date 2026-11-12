# Changelog

Every vibest API is experimental until it is declared stable (`.agents/rules/api-stability.md`): it may change in any
release. Each release lists what broke, who is affected and how to migrate under "Breaking changes".

## Unreleased

### Breaking changes

- **Pull or type depends only on the harness; the entry session is an ordinary session** (anyone reading
  `vibest.db` or `vibest ls`, harness integration and plugin authors): a harness that declares `inbox` (Claude, Pi)
  takes its next batch with `Inbox.Take` / `/inbox/take` when it is idle, for the entry session and spawned sessions
  alike; any other harness (Cursor) is typed into. vibestd does not hand out the next batch while an execution is open.
  A pulled batch is `delivered` and attached to its execution when it is taken, and the integration reports the
  execution accepted when the batch reaches the model; `/inbox/ack`, `Inbox.Ack`, the poll leases and the away timer
  are gone, `Inbox.Subscribe` only wakes the session, and its access level is `session`. Entry executions are recorded
  like any other (an entry execution can be judged `lost`), and `vibest ls` shows the entry as an ordinary row. A
  session with no creator (the entry session) does not switch harness on a usage limit. The protocol number is
  unchanged; the contract snapshot is regenerated.
- **`vibest run` runs only inside a session** (users, scripts): a `vibest run` in a plain terminal is refused with a
  pointer to bare `vibest`, which opens a session. Every session `vibest run` starts, here or on another machine, records
  the session that ran it as its creator; `NoCallingSession` is the new error. Any session, not only the entry
  session, can now run `vibest run`.
- **An execution opens when its input is sent and is accepted once the harness takes it up** (anyone reading
  `vibest.db`, harness and runtime plugin authors): a send that never sees the harness ready leaves no execution (no
  `not_started` row); the catalog adds `execution.accepted` and an optional `failure.kind` (`limit`) on
  `execution.ended`, and the read model (projection 6) adds `execution.accepted_at` and `execution.failure_kind`.
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
  (ignored when `harness` is not the session's). The `Coordinator` caller shape is `Entry`. The entry session's `name`
  in `vibest ls` JSON is `entry` (was `main`), and errors that named the coordinator for the project's entry session say "entry session". The herdr action
  `open-main` is `open-entry` (rebind a key set to `vibest.open-main`), the runtime `present` info key `mainSession`
  is `entrySession`, and CLI help and errors say "entry session" where they said "main agent". The protocol number
  is unchanged. A session whose agent is named `entry` is an ordinary session: the entry session is the one the project records.
- **Another machine's vibestd is told who made a call** (anyone running vibest on two machines, and RPC clients): a
  call forwarded as `<machine>/<id>` carries the header `vibest-peer-by` (`user` or the calling session's id), and the
  other vibestd refuses a forwarded call without it. A session reaches on the other machine only the sessions it
  started there, and what it sends is signed with its id. `Peer.Spawn` is run only by a session (`reportTo` is no longer a field; the
  session in `vibest-peer-by` is the creator), so `vibest run --machine` outside a session is refused. What a session
  on the other machine sends to its creator arrives as a message (`<agent-message>` naming `<machine>/<id>`), not as a
  notice; `Peer.Outbox` items have `kind` `send` or `notice` (was `result` or `notice`), and the read model (projection 7) gives `outbox` a `kind`.
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
  (`send` or `notice`, `notice` when absent), and `peer.seen` has no `callsMe`. The read model (projection 5) has table `execution` (`outcome`,
  `reply`) instead of `turn` (`status`, `answer`), `session.agent` instead of `role`, no `session.turn_id` (a session's
  latest execution is its highest `execution.id`), no `session.archive_on_idle`, `process.ready_seq`, `inbox.seq`
  (a task with no `execution_id` was never handed over), `outbox.kind` or `peer.calls_me`, and `process`, `execution`
  and `inbox` keyed by `(session_id, id)`, with `inbox.session_id` (the recipient, never null) instead of
  `recipient_session_id` and `inbox.execution_id` instead of `turn_id`.
  vibestd and `vibest daemon import-check` refuse a database in the old shape as one from an older vibest and change
  nothing in it; there is no automatic conversion. Migrate: with vibestd stopped, move `vibest.db` aside with its
  `-wal` and `-shm` files to start empty (the message gives the command).
- **turn is execution, and an execution's answer or result is its reply** (protocol 10: scripts reading CLI JSON,
  RPC clients, harness and runtime plugin authors): session rows in `vibest ls`, `vibest result` and Watch have
  `executionState` instead of `turnState`; `vibest result` (RPC `Get`) has `reply` instead of `answer`, and its
  `turn` is `execution`; a Watch session's `turn` is `finished`, and `Session.Seen` takes `{ id, finished }`. The
  RPC `TurnEnd` is `ExecutionEnd`, the hook route `/hooks/<harness>/turn-end` is `/hooks/<harness>/execution-end`,
  and the Claude plugin's end event is `ExecutionComplete`. A `HarnessDefinition` has `executionEnd` (returning
  `{ end }`, was `turnEnd` returning `{ result }`) and `replyField` (was `resultField`); a runtime's `Seen` has
  `finished` (was `turn`) and `see(terminal, finished)`; `agent.fail` gets the limited execution's `input` (was
  `turn`). Migrate: rename the fields; a vibest of another protocol is refused, so update every vibest together
  (`vibest update`).
- **`vibest run --archive-on-idle`** (users): the flag is no longer stored. A session started with it is still
  archived when it is idle after a completed turn, but only by the vibestd that started it: after a vibestd restart
  or `vibest update` it stays until archived by hand.
- **Turn ends** (anyone reading `vibest.db`, and anyone counting turns): a turn end the harness reports is written at
  once as `turn.ended`, carrying `reply` and `conversation`; vibestd no longer writes `turn.reported` (older ones still
  decode and project), so `turn.report_seq` stays null for new turns. An older vibest cannot read a log with the new
  `turn.ended` keys. A usage limit now ends its turn `failed` and the next harness gets the input in a new turn, so a
  limit move is two turns instead of one. A reply that arrives after vibestd gave a turn up as `lost` is a turn of its
  own. A turn stopped in its terminal (Esc) is `interrupted`, with no failure and no notice, like `vibest interrupt`.
- **Plugin hooks return their decisions** (plugin authors): hooks no longer change the event they are given. Each
  callback gets a read-only event (frozen: an assignment throws, and the plugin is reported as crashed, so a run it
  routes fails with `plugin <id> crashed: …`) and returns what it decides, which core applies in plugin order, a
  later plugin overriding an earlier one as before. `agent.start.before` returns an `AgentRoute` (any of `prompt`,
  `harness`, `provider`, `model`, `machine`, `runtime`; `undefined` unsets `harness`, `provider`, `model` or
  `runtime` and leaves `prompt` and `machine` as they are), `agent.fail` returns an
  `AgentMove`, and `machine.connect`/`machine.remove` return their notes. `AgentFail` has no `move` and
  `MachineEvent` has no `notes`; `@vibest/plugin/testing` `machineHooks().fire` takes an event without `notes`. The
  trace's `changes` list the fields each callback returned. Migrate: `e.harness = "pi"` becomes
  `return { harness: "pi" }` (for example `Effect.succeed({ harness: "pi" })`), `e.move = m` becomes `return m`, and
  `e.notes.push(n)` becomes `return [n]`.
- **Promise plugins** (plugin authors): a plugin may be `Plugin.define({ id, setup })` instead of `{ id, effect }`:
  `setup` gets a context of Promises (hook callbacks return a value or a Promise and refuse by throwing
  `AgentRefused`, `event.subscribe` is an `AsyncIterable`) and may return a cleanup that runs when the plugin unloads.
  `Plugin.Plugin` is now the union `EffectPlugin | PromisePlugin`, so code that calls `plugin.effect` on a
  `Plugin.Plugin` calls `Plugin.effectOf(plugin)` instead.
- **The read model** (anyone reading `vibest.db`): the projection is version 4 and is rebuilt from the log when vibestd
  opens the file. `session.report_to_session_id`, `session.origin_parent`, `session.seq`, `project.seq`,
  `inbox.queued_at` and `process.resume` are gone: a session's notices go to its parent while it lives, else to the
  entry session, and `process.conversation` starts as the conversation the process resumes.
  `session.archive_on_completion` is now `archive_on_idle`, and `session.origin_report_to` is now `origin_session`.
  New facts no longer write `session.created` `reportTo` or `origin.parent`; older facts that carry them still decode.
- **`Peer.Spawn`** (vibestd to vibestd): the payload has no `parent`; `reportTo` names the origin project's entry session, where remote notices and sends go back to.
- **Agent messaging** (users, plugin authors, anyone calling the RPC): a turn that ends normally or is interrupted
  sends nothing. Agents send what they decide to with `vibest send <id> -- '<message>'` (to their creator, or any agent
  of the project), and the main agent reads `vibest ls` (state) and `vibest result <id>` (the last reply, in `answer`).
  vibest notifies the creator only of what an agent cannot say: its harness exited, its turn ended in an error, it
  never started, it waits on a permission, or a message to it was not delivered. `vibest report`, the RPC `Report`,
  `SessionStatusInfo.result` and the `<agent-result>` message are removed, `PROTOCOL` is 9 (run `vibest update`), and
  the read model has no `inbox.result_turn_id`. Migrate: replace `vibest report` with `vibest send`, and read an
  agent's answer from `answer` instead of `result`.
- **The database** (users, and anyone reading `vibest.db`): vibestd stores an append-only log of facts and a read model
  projected from it, and applies schema migrations recorded in a `migration` table when it opens the file. It refuses
  a database from an earlier version (`SchemaMismatch`, the file unchanged): there is no automatic conversion; move it
  aside with its `-wal` and `-shm` files while vibestd is stopped to start empty. An older vibest cannot open the new
  file. Tools that read the tables directly must read the new ones (`docs/design/schema.md`): `process`, `turn` and the
  `event` log with the new fact types replace the old `event` rows (`process.start`, `turn.end`, `inbox.status`, …),
  and sessions have no `machine` column. `vibest daemon
  import-check` now replays the log and fails when the read model differs from the replay.
- **Runtime plugins** (plugin authors): a plugin is only `{ id, effect }`. `caller` moves from the plugin into the
  runtime definition, the runtime's `kind` is renamed `id`, and `context.runtime.register(runtime)` is replaced by
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
- **`vibest run auto` is removed** (users, scripts, skills): leave the harness out to start the new agent on its
  caller's harness, provider and model (`vibest run -- <prompt>`); name one to switch. With nothing to inherit (a plain
  terminal in a project without a main agent) the start fails with "no harness to inherit". A project's first `vibest`
  without `--harness` fails asking for one; later starts reuse the main agent's last harness.
- **No quota-based harness choice** (users): the builtin `harness-choice` plugin and `@vibest/plugin-harness-choice`
  are removed. A named harness whose subscription is limited now starts and fails its round when the limit hits; it is
  no longer refused or rerouted. A plugin on `agent.start.before` may still route by the subscriptions in the event.
- **Protocol 8** (users): the CLI and vibestd must match. Run `vibest update`, or `vibest daemon restart` after
  installing, so a running vibestd is replaced. Harness ids in every RPC are plain strings.
- **`Harnesses.List`** (RPC clients, scripts reading it): takes an optional `{ provider }` and each row gains `binary`.
  The Ping capability `harnesses` is removed; protocol 8 implies the method. New RPC `Integration.Guard`.
- **`Project.StartMain`** (RPC clients): `harness` is optional and the error union gains `LaunchFailed`. A first start
  without a harness (no main agent to inherit from) now fails with `LaunchFailed` instead of `NoHarnessChosen`.
