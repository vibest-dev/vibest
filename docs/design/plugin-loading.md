# Plugin loading

Implementation notes for the [plugin architecture](architecture.md#7-plugin-architecture).

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

In `plugin-sources.ts`: a half-saved `vibest.json` keeps its last parsed plugin list. A plugin directory whose
`package.json` has a `name` and `exports` loads, as OpenCode's `Host.resolve`, the first existing file `exports` maps
for `./server`, then for `.` (taking the first of the `bun`, `import` and `default` conditions), and nothing else; the
mapped files are watched until one exists. vibest reads the map itself, because Bun's resolver keeps a lookup that
failed once (for example while `package.json` was written before its entry), so a self-reference resolution would stay
failed until vibestd restarts. Without `exports` it loads `server.*`, else `index.*`. An
entry is imported by its real path, so imports resolve next to the real file and Bun never sees two paths for one
module (its resolver keeps failing for files added later under a symlinked directory, such as /var on macOS); a
dangling link is watched at its target until it appears. Imports are cached by the digests of the entry's local
graph and of the listings of its unresolved import directories: an unchanged graph is not imported again, failed or
not, so unrelated saves never repeat a broken plugin's import-time effects. An import that never settles times out
like a setup. A package a plugin imports that does not resolve is watched at `node_modules/<package>` in every directory
from the importing file up to the plugin's package root (the nearest `package.json`) or the user home, never `/`,
and an installed folder that does not resolve yet (an install still writing) stays watched, so installing it imports
the plugin again; `effect`, `@vibest/plugin` and their subpaths are supplied by vibestd and never watched; a package that resolves is neither watched
nor evicted, and an upgraded package already loaded needs a vibestd restart. While the watched
directories change the plugins are read again, because a change made before its watch began is not reported. The watch only makes a change show up fast; it is not what makes it show up at all: vibestd also
reads the plugins again every second, and an unchanged read imports and sets up nothing. On macOS Bun 1.4 serves every
`fs.watch` of a process from one FSEvents stream and rebuilds it, from "now", whenever a watch is added or closed, and
under load FSEvents drops events outright (Bun does not pass on its "dropped, rescan" flags): a write can go unreported
for good, while the next unrelated write is reported. The periodic read bounds that loss to about a second. A teardown that times out is left
running, so an old revision's finalizers can overlap the new setup.

## Machine hooks

`ctx.machine.hook("connect" | "remove", callback, { runtime? })` subscribes to `machine.connect` and `machine.remove`
and returns a `Registration`; `{ runtime: id }` scopes the hook to one runtime (`Plugins.machine(hook, event,
runtime?)`: with a runtime, the hooks scoped to it plus the unscoped ones run; without one, all of them). Unlike
`agent.*`, every subscriber runs, one after another, even after one crashed or timed out; each is bounded by 30 s (hc's
own dial goes over ssh), not the 5 s host default. Each callback gets a frozen event and returns its notes (an array of
`{ message, fix? }`, or void); the notes come back tagged with the plugin, and a crash or a timeout becomes a note of
its own (`plugin <id> crashed: …`, `plugin <id> timed out after 30s`). Each commit of the
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
ones. Bun 1.4 remembers a package lookup that failed (the directory without `node_modules`, the missing package
folder) for the life of the process, so once the graph finds a package installed it makes Bun forget the directory
holding that `node_modules` and the package folder, by resolving a missing absolute path in each (a miss makes Bun
drop the directory's cached listing and retry); without that the plugin's next import fails again until a restart.
`packages/cli/test/plugin-source.test.ts` fails when Bun changes this. Each load imports the entry and its local imports under keys of their own (`<file>?vibest-load=<n>`), after
dropping the previous and current graph from the module registry, so a changed transitive import is evaluated again
and old revisions do not pile up: since Bun 1.4.3 a module whose top-level await never settled stays in the
registry under its path, outside `require.cache`, and every later import of that path waits for it. `node_modules`
keeps its plain keys, so it is shared and never reloaded. Bun hands `onResolve` the importer without its query, so
each file remembers the load that last imported it, and a later `import("./lazy.ts")` from a running plugin gets that
plugin's key. A watched directory that goes away closes its watcher; the next read watches what still exists.
