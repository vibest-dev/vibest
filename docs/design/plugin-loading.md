# Plugin loading

Implementation notes for the [plugin architecture](architecture.md#7-plugin-architecture-effect-only).

## Order and boundary

Builtin plugins load first, in the order of `pre` in `packages/builtins/src/index.ts` (`harness-pi`, `harness-claude`,
`harness-cursor`, `runtime-herdr-core`, `runtime-herdr`, `runtime-choice`), then the plugins directory, then
`vibest.json` in the order written. Registration order is detection order for runtime callers (herdr-core before
herdr) and the order of `transform`s on a registry, so a user plugin sees and may change the builtin definitions.
`vibest plugins` lists them in that order.

Builtin plugins and harness integrations are written like a user plugin: `packages/plugin-harnesses`,
`packages/runtime-herdr`, `packages/runtime-herdr-core` and `packages/integration/*/src` import only `@vibest/plugin`,
`@vibest/schema`, `@vibest/protocol` and `@vibest/client`, and `packages/builtins` never imports core, server or the
CLI. `.oxlintrc.json` enforces it with `no-restricted-imports` overrides (static, type-only and dynamic imports alike),
and `vibest/no-restricted-disable` reports a disable comment for that rule. What a builtin needs from the platform
(child processes, files, HTTP) it provides itself from `@effect/platform-node-shared`.

## Loading and watching

In `plugin-sources.ts`: a half-saved `vibest.json` keeps its last parsed plugin list. An
entry is imported by its real path, so imports resolve next to the real file and Bun never sees two paths for one
module (its resolver keeps failing for files added later under a symlinked directory, such as /var on macOS); a
dangling link is watched at its target until it appears. Imports are cached by the digests of the entry's local
graph and of the listings of its unresolved import directories: an unchanged graph is not imported again, failed or
not, so unrelated saves never repeat a broken plugin's import-time effects. An import that never settles times out
like a setup. `node_modules` is neither watched nor evicted: a dependency installed later is retried only when the
plugin's own graph changes, and an upgraded one already loaded needs a vibestd restart. While the watched
directories change the plugins are read again, because a change made before its watch began is not reported; after
such a rewatch one more read follows a second later, because Bun 1.4's `fs.watch` on macOS sometimes drops other
directories' events right after a watch closes (drop it when Bun no longer does). A teardown that times out is left
running, so an old revision's finalizers can overlap the new setup.

## Machine hooks

`ctx.machine.hook("connect" | "remove", callback, { runtime? })` subscribes to `machine.connect` and `machine.remove`
and returns a `Registration`; `{ runtime: id }` scopes the hook to one runtime (`Plugins.machine(hook, event,
runtime?)`: with a runtime, the hooks scoped to it plus the unscoped ones run; without one, all of them). Unlike
`agent.*`, every subscriber runs, one after another, even after one crashed or timed out; each is bounded by 30 s (hc's
own dial goes over ssh), not the 5 s host default. The event's `notes` come back tagged with the plugin, and a crash or
a timeout becomes a note of its own (`plugin <id> crashed: …`, `plugin <id> timed out after 30s`). Each commit of the
runtime registry publishes the ids of the runtime definitions it added or replaced (`Runtimes.added`), and `connect`
fires for each of them on every connected machine, so a runtime plugin loaded later catches up. When they fire:
[multi-machine.md](multi-machine.md#terminals-on-other-machines). `@vibest/plugin/testing` `machineHooks(plugin)`
fires a plugin's machine hooks in its own tests.

## Running hooks

`hooks.ts` registers and runs both `agent.*` and `machine.*` hooks: each plugin keeps its registrations, and
`Hooks.run` bounds one call and counts it in the plugin's stats. Every hook runs in the host's scope, not its plugin's,
so a reload or a disabled plugin never cuts short a call in flight: it finishes on the plugin snapshot it started with
and is only interrupted by its own timeout or by vibestd shutting down. Setups, teardowns and hook calls are bounded by
`timeoutWithoutWaiting` (`bounded.ts`), not `Effect.timeout`: `Effect.timeout` interrupts the late effect and waits for
it to stop, which never happens for plugin code that is uninterruptible or ignores interruption, so the helper returns
at the deadline and leaves the interrupt to a detached fiber (effect 4.0.2 has no `Effect.disconnect`).

## Loading on Bun

In `platform/bun.ts` and `platform/plugin-source.ts` (after OpenCode V2's `source.bun.ts`): inside the
compiled binary nothing resolves a plugin's `effect` and `@vibest/plugin` imports, and a copy beside the plugin would
be a second effect instance, so `Bun.plugin` maps them to vibestd's own modules (`effect/X` is `effect.X` for every
top-level module the root namespace exports). A plugin's graph is its entry and the local files it imports,
transitively, outside `node_modules`; a local import that does not resolve yet adds its directory to the watched
ones. Each load imports the entry and its local imports under keys of their own (`<file>?vibest-load=<n>`), after
dropping the previous and current graph from the module registry, so a changed transitive import is evaluated again
and old revisions do not pile up: since Bun 1.4.3 a module whose top-level await never settled stays in the
registry under its path, outside `require.cache`, and every later import of that path waits for it. `node_modules`
keeps its plain keys, so it is shared and never reloaded. Bun hands `onResolve` the importer without its query, so
each file remembers the load that last imported it, and a later `import("./lazy.ts")` from a running plugin gets that
plugin's key. A watched directory that goes away closes its watcher; the next read watches what still exists.
