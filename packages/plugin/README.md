# @vibest/plugin

**Experimental.** This API may change in any release, without aliases or a deprecation period, until vibest declares it
stable.

The authoring API for vibest plugins. vibestd provides this module and `effect` to a plugin when it loads it, so a
plugin imports both normally and bundles neither.

## A plugin

A plugin is an id and an effect (`@vibest/plugin/effect`), or an id and a Promise `setup` (`@vibest/plugin`). The effect
runs once per load in the plugin's own scope; everything it registers lasts until the plugin is unloaded or reloaded.

```ts
import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "my-plugin",
  effect: (context) => Effect.void,
})
```

Or write it with Promises: `setup` gets the same context with Promises (hook callbacks return a value or a Promise and
refuse by throwing `SessionRefused`; `event.subscribe` is an `AsyncIterable`) and may return a cleanup that runs when the
plugin unloads.

```ts
import { Plugin } from "@vibest/plugin"

export default Plugin.define({
  id: "my-plugin",
  setup: async (context) => {
    await context.session.hook("start.before", async (event) => {
      if (event.prompt.startsWith("ask:")) event.harness = "pi"
    })
    return () => console.log("unloaded")
  },
})
```

Drop the file into `$VIBEST_HOME/plugins/`, or add the file or a folder (`index.ts`, or a `package.json` with `exports`) to `plugins` in `vibest.json`. `context.options` holds the
options its entry gives (`{ "package": "./my-plugin", "options": { … } }`); they reload live. `vibest plugins`
lists every plugin, builtins first, with its status and counters.

## Context

| Member                | What it does                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `options`             | the plugin's options                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.hook`        | intercept `start.before` (assign `prompt`, `harness`, `provider`, `model`, `machine`, `runtime` to change; refuse with `SessionRefused`; read `files`, the absolute paths of the files attached with `vibest run --file`) and `fail` (assign `move`)                                                                                                                                                         |
| `runtime.transform`   | add, change or remove `Runtime.RuntimeDefinition`s                                                                                                                                                                                                                                                                                                                                                           |
| `harness.transform`   | add, change or remove `Harness.HarnessDefinition`s                                                                                                                                                                                                                                                                                                                                                           |
| `subscription.report` | replace one `(harness, provider)` row's usage limits                                                                                                                                                                                                                                                                                                                                                         |
| `session.list`        | the running sessions as `PluginSession`: `id`, `title`, `parentId`, `status`, `lastActive` (when it last did anything), `waiting` (an execution is open or a message to or from it waits), and `latest` (the latest ended execution: `execution`, `outcome`, `sent`, the messages the session sent during it, and `endedAt`)                                                                                 |
| `session.get`         | one running session by id, or `undefined`                                                                                                                                                                                                                                                                                                                                                                    |
| `session.sentIn`      | `(id, execution)`: how many messages the session sent during that execution                                                                                                                                                                                                                                                                                                                                  |
| `session.send`        | `{ to, message, request? }`: queue a message from this plugin (shown "Message from Vibest · <plugin id>"); one to a session that ended goes to the nearest running session above it on this machine; a repeat of `request` queues nothing; fails with `SessionSendFailed`                                                                                                                                    |
| `session.stop`        | `(id, { idleSince? })`: stop a running session as `vibest stop` does (recorded as stopped by this plugin): its harness ends and its terminal closes, its worktree and messages stay, and the next message resumes it; with `idleSince` only if it did nothing after that time and nothing waits; answers whether this call stopped it; the entry session and archived sessions fail with `SessionStopFailed` |
| `event.subscribe`     | a `Stream` of the ledger's facts after they commit, all or only the `types` asked for; run it with `Effect.forkScoped`                                                                                                                                                                                                                                                                                       |

**Hooks** run in plugin order; each callback gets the event, changes it by assigning to its fields, and has 5 seconds. A callback that times out or fails changes nothing. **Transforms** take a synchronous
editor (`add`; the harness editor also has `update`) and apply in registration order, so a later plugin sees and may
change what earlier ones, builtins included, defined. Load effectful data before registering a transform. A transform that throws fails the whole plugin and removes what it registered.

`hook` and `transform` return a `Registration`. Its `dispose` removes it early (a second call does nothing); the
plugin's scope disposes the rest when it unloads, and removing a transform restores the definitions it changed.

## A runtime plugin

A runtime is where agents' terminals live. Its definition has an `id`, the required members (`status`, `events`,
`open`, `send`, `read`, `process`, `close`) and optional ones, and an optional `caller`: the environment variables its
terminals set, so `vibest` started in one of them runs there.

```ts
import { Plugin, Runtime } from "@vibest/plugin/effect"
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
inline arrow each time makes vibest treat the runtime as replaced (a `runtime.reset` and a `machine.connect` per connected
machine).

`runtimeContract(definition, { cwd })` from `@vibest/plugin/testing` checks a definition against a real local
instance.

## A harness plugin

A harness is a coding-agent CLI. The builtin ones (`pi`, `claude`, `cursor`) are plugins too, so a plugin may add a
harness or change one:

```ts
import { Plugin } from "@vibest/plugin/effect"
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
