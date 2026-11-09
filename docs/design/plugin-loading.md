# Plugin loading

Implementation notes for the [plugin architecture](architecture.md#7-plugin-architecture-effect-only).

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

`ctx.machine.hook("connect" | "remove", callback)` subscribes to `machine.connect` and `machine.remove`
(`Plugins.machine(hook, event, only?)`). Unlike `agent.*`, every subscriber runs, one after another, even after one
crashed or timed out; each is bounded by 30 s (hc's own dial goes over ssh), not the 5 s host default. The event's
`notes` come back tagged with the plugin, and a crash or a timeout becomes a note of its own (`plugin <id> crashed: …`,
`plugin <id> timed out after 30s`). `only` reaches one plugin. `ctx.runtime.register` records which plugin owns each
runtime kind (`Plugins.ownerOf`), dropped when that plugin stops, and every activation publishes the ids of the
plugins it started (`Plugins.activated`), so a plugin loaded later catches up on the connected machines. When they
fire: [multi-machine.md](multi-machine.md#terminals-on-other-machines). `@vibest/plugin/testing` `machineHooks(plugin)`
fires a plugin's machine hooks in its own tests.

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
