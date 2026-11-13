# Plugins

vibestd loads plugins from the vibest home's plugins folder and from `vibest.json`. Each capability below says what it
is and when it counts as working.

## G1. Listing plugins

`vibest plugins` lists a plugin from the plugins folder, one named in `vibest.json`, and one named there by a `file://`
URL whose path has an escaped space, all active with zero counters.

## G2. Reloading an edited plugin

Editing a plugin file reloads it without a daemon restart: `vibest plugins` shows the new version, and vibestd is the
same process. An Effect plugin edited into the `{ id, setup }` form reloads the same way. A plugin whose teardown fails
is logged by id and cause, and its edited revision still runs.

## G3. A plugin that fails to load

A plugin that throws while loading, including one whose setup throws instead of returning an Effect, is listed with its
error, and the other plugins, those after it included, stay active.

## G4. A plugin refuses a run

A plugin hook that refuses a run blocks `vibest run` with its reason before any pane or worktree exists: the command
fails and prints the reason. A hook that throws instead of returning an Effect blocks the run the same way, printing
`plugin <id> crashed: <error>`, and counts as a crash of that plugin; so does a hook written in the old style that
assigns to the event it is given instead of returning its decision.

## G5. A routing plugin picks the harness

A plugin can pick the harness for `vibest run`. The builtin plugin `harness-default` picks Claude when nothing else has
chosen (no `--harness`, nothing to inherit) and Claude is available; with `"-harness-default"` in `plugins` and no
plugin of one's own, such a run fails saying there is no harness to inherit. With a plugin that picks Pi, the same run starts a Pi session, `vibest ls`
names the plugin as the one that decided the harness (the `routing` field of `vibest ls` and `vibest result`; `vibest
run` itself prints only `{"id":"<session id>"}`), and the result arrives.

## G6. A plugin changes a builtin harness

A user plugin can change a builtin harness, for example the binary it runs: `vibest harness list` shows the changed
definition as startable, and the next `vibest run` of that harness starts that binary. Removing the plugin restores the
builtin harness.

## G7. A plugin adds a runtime

A user plugin can add a terminal runtime and route an agent to it; the agent starts there and reports its status from
it.

## G8. A broken edit keeps the running plugin

Editing a plugin into one that fails to import leaves the running revision as it is: `vibest plugins` shows it active
with the failed revision and its error, and neither it nor the plugins after it are set up again.

## G9. One plugin per target

A plugin folder found in the plugins folder and also named in `vibest.json` is one plugin: `vibest plugins` lists it
once, active, and it runs with the options from `vibest.json`.

## G10. A plugin folder with a package.json

A plugin folder whose `package.json` maps `exports` loads the file the map names for `./server`, else for `.`, skipping a
file that does not exist, and never a file the map does not export. While a package it imports is not
installed it is listed as failed with the missing package; installing the package into its `node_modules` makes it
active without editing the plugin or restarting vibestd.

## G11. A plugin disabled by a failing transform

A plugin whose transform throws is disabled and listed as failed with the error. A reload caused by another plugin
does not set it up again; editing the plugin itself does.

## G12. A plugin observes the ledger's facts

A plugin that subscribes with `ctx.event.subscribe` to `session.created`, `process.started`, `execution.started` and
`execution.ended` gets those facts of a real Pi subagent, in that order, and none it did not ask for. A plugin that
subscribes to every fact gets no signal. After the plugin is edited, the new revision gets the next agent's
facts and the old one gets nothing more.

## G13. A plugin written with Promises

A plugin defined as `{ id, setup }` with Promises loads like an Effect plugin: its `agent.start.before` callback routes
`vibest run -- <task>` to a real Pi and `vibest ls` names it as the decider, its `event.subscribe` iterator gets the
agent's `execution.ended`, and deleting its file unloads it and runs the cleanup its `setup` returned. Editing an Effect
plugin into the `setup` form reloads it like any edit (G2).

## G14. A builtin plugin can be removed

`"-<id>"` in `vibest.json` removes the builtin plugin with that exact id (for example `"-harness-default"`); `"-*"` and
`"-prefix.*"` never match builtins. The removal counts from the config text as soon as vibestd starts, even while slow
user plugins are still importing, and deleting the line brings the builtin back without restarting vibestd.
