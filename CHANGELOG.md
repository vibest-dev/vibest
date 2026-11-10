# Changelog

Every vibest API is experimental until it is declared stable (`.agents/rules/api-stability.md`): it may change in any
release. Each release lists what broke, who is affected and how to migrate under "Breaking changes".

## 0.0.1-beta.18 (2026-11-10)

### What's new

- **Multi-machine over ssh**: `vibest machine add <name> <ssh target>` connects to another machine's vibestd;
  `vibest run --machine <name>` starts an agent there, `<machine>/<id>` works wherever a session id does, `vibest ls`
  lists every connected machine's sessions, and remote results come back to this machine's main agent.
- **Remote terminal view** for herdr-core and herdr: a runtime shows and steps into another machine's agent terminals;
  with herdr, `vibest machine add` and `rm` keep that machine's herdr session in this machine's saved herdr machines.
- **Plugin API aligned with OpenCode V2**: a plugin is `{ id, effect }`; runtimes and harnesses are registered through
  `transform` editors, and hooks return a disposable `Registration` (see Breaking changes).
- **An event-driven vibestd**: no background polling, deliveries follow turn ends; every CLI command and the hourly
  update check go through vibestd.
- **`preferences.md`** replaces `instructions.md`, and memories reach an agent as an index of one-line summaries.

### Fixes

- `vibest interrupt` gives a result when background work keeps the terminal working after Esc.
- `vibest update` and `vibest daemon restart` never leave the user stuck.
- vibestd repairs operations a crash cut off; a retried `send` or `run` queues once.
- Reconcile and delivery races with slow shells and killed harnesses.
- A main agent's `--env` never reaches the typed command or shell history.
- Reading git state takes no index lock, so it cannot fail a spawn.
- An unavailable harness is refused instead of switched silently.
- Pi ready reports are retried across a vibestd restart; Cursor reports to vibestd through plugin hooks and no longer
  opens keychain dialogs under temporary homes.
- Builtin runtimes register before vibestd admits a request.

### Breaking changes

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
