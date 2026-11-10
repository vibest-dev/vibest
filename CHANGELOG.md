# Changelog

Every vibest API is experimental until it is declared stable (`.agents/rules/api-stability.md`): it may change in any
release. Each release lists what broke, who is affected and how to migrate under "Breaking changes".

## Unreleased

### Breaking changes

- **The database** (users, and anyone reading `vibest.db`): vibestd stores an append-only log of facts and a read model
  projected from it. The first vibestd of this version imports the existing database once, in place, when it opens it
  (one transaction, no backup file); sessions, prompts, results and queued messages carry over. When the import fails,
  vibestd still starts with an empty history, keeps the old tables as `v1_<name>` in the same file, prints a
  `LedgerNotImported:` line with the reason (in the vibestd log and on the starting `vibest`), and `vibest ls` shows a
  `notice`. An older vibest cannot open the file afterwards: going back means moving `vibest.db` aside. Tools that read
  the tables directly must read the new ones (`docs/design/schema.md`): `process`, `turn` and the `event` log with the
  new fact types replace the old `event` rows (`process.start`, `turn.end`, `inbox.status`, …), `inbox.result_turn_id`
  replaces `result_event_id`, and sessions have no `machine` column. `vibest daemon import-check` now also replays the
  log of an imported database and fails when the read model differs from the replay. `vibest ls` may carry a `notice`
  field.
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
