# Changelog

Every vibest API is experimental until it is declared stable (`.agents/rules/api-stability.md`): it may change in any
release. Each release lists what broke, who is affected and how to migrate under "Breaking changes".

## Unreleased

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
