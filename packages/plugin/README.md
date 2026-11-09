# @vibest/plugin

The authoring API for vibest plugins. vibestd provides this module and `effect` to a plugin when it loads it, so a
plugin imports both normally and bundles neither.

## A plugin

A plugin is an id and an effect. The effect runs once per load in the plugin's own scope; everything it registers lasts
until the plugin is unloaded or reloaded.

```ts
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

export default Plugin.define({
  id: "my-plugin",
  effect: (context) => Effect.void,
})
```

Add it to `plugins` in `vibest.json`, or drop the file into `$VIBEST_HOME/plugins/`. `context.options` holds the
options its entry gives (`{ "package": "./my-plugin.ts", "options": { … } }`); they reload live. `vibest plugins`
lists every plugin, builtins first, with its status and counters.

## Context

| Member                             | What it does                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `options`                          | the plugin's options                                                                                                                     |
| `agent.hook`                       | intercept `start.before` (write `prompt`, `harness`, `provider`, `model`, `runtime`; refuse with `AgentRefused`) and `fail` (set `move`) |
| `runtime.transform`                | add, change or remove `Runtime.RuntimeDefinition`s                                                                                       |
| `harness.transform`                | add, change or remove `Harness.HarnessDefinition`s                                                                                       |
| `runtime.reload`, `harness.reload` | rebuild that registry, for a transform that reads data of its own                                                                        |
| `subscription.report`              | replace one `(harness, provider)` row's usage limits                                                                                     |

**Hooks** run in plugin order on one mutable event; each callback has 5 seconds. **Transforms** take a synchronous
editor (`list`, `get`, `add`, `update`, `remove`) and apply in registration order, so a later plugin sees and may
change what earlier ones, builtins included, defined. Load effectful data before registering a transform or calling
`reload`. A transform that throws fails the whole plugin and removes what it registered.

`hook` and `transform` return a `Registration`. Its `dispose` removes it early (a second call does nothing); the
plugin's scope disposes the rest when it unloads, and removing a transform restores the definitions it changed.

## A runtime plugin

A runtime is where agents' terminals live. Its definition has an `id`, the required members (`status`, `events`,
`open`, `send`, `read`, `process`, `close`) and optional ones, and an optional `caller`: the environment variables its
terminals set, so `vibest` started in one of them runs there.

```ts
import { Plugin, Runtime } from "@vibest/plugin"
import { Effect } from "effect"

declare const mine: Omit<Runtime.RuntimeDefinition, "id" | "caller">

const definition: Runtime.RuntimeDefinition = {
  ...mine,
  id: "mine",
  caller: { env: ["MINE_TERM"], terminal: (env) => Effect.succeed(env.MINE_TERM) },
}

export default Plugin.define({
  id: "runtime-mine",
  effect: (context) => context.runtime.transform((editor) => editor.add(definition)).pipe(Effect.asVoid),
})
```

Keep stable references in runtime definitions: build the definition (and any function you put in it with `update`)
once, outside the transform, because every registry commit runs all transforms again, and a member that is a new
inline arrow each time makes vibest treat the runtime as replaced (a `live.reset` and a `machine.connect` per connected
machine).

`runtimeContract(definition, { cwd })` from `@vibest/plugin/testing` checks a definition against a real local
instance.

## A harness plugin

A harness is a coding-agent CLI. The builtin ones (`pi`, `claude`, `cursor`) are plugins too, so a plugin may add a
harness or change one:

```ts
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

export default Plugin.define({
  id: "claude-wrapper",
  effect: (context) =>
    context.harness
      .transform((editor) =>
        editor.update("claude", (definition) => {
          definition.binary = "claude-wrapper"
        }),
      )
      .pipe(Effect.asVoid),
})
```

## Stability

The plugin API is experimental, like every vibest API until vibest declares one stable: it may change in any release,
without aliases or a deprecation period. Each release lists what broke and how to migrate under "Breaking changes" in
[CHANGELOG.md](../../CHANGELOG.md).
