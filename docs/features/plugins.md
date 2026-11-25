# Plugins

vibestd loads plugins from the vibest home's plugins folder and from `vibest.json`. Each capability below says what it
is and when it counts as working.

## G1. Listing plugins

`vibest plugins` lists a plugin from the plugins folder, one folder named in `vibest.json`, one named there by a `file://`
URL whose path has an escaped space, and one single file named there, all active with zero counters.

## G2. Reloading an edited plugin

Editing a plugin file reloads it without a daemon restart: `vibest plugins` shows the new version, and vibestd is the
same process. An Effect plugin edited into the `{ id, setup }` form reloads the same way. A plugin whose teardown fails
is logged as an error with its plugin id and cause, and its edited revision still runs.

## G3. A plugin that fails to load

A plugin that throws while loading, including one whose setup throws instead of returning an Effect, is listed with its
error, and the other plugins, those after it included, stay active.

## G4. A plugin refuses a run

A plugin hook that refuses a run blocks `vibest run` with its reason before any pane or worktree exists: the command
fails and prints the reason. A hook that throws instead of returning an Effect blocks the run the same way, printing
`plugin <id> crashed: <error>`, and counts as a crash of that plugin.

## G5. A routing plugin picks the harness

A plugin can pick the harness for `vibest run`. The builtin plugin `vibest.harness-default` picks Claude when nothing else has
chosen (no `--harness`, nothing to inherit) and Claude is available; with `"-vibest.harness-default"` in `plugins` and no
plugin of one's own, such a run fails saying there is no harness to inherit. With a plugin that picks Pi, the same run starts a Pi session, `vibest ls`
names the plugin as the one that decided the harness (the `routing` field of `vibest ls` and `vibest result`; `vibest
run` itself prints only `{"id":"<session id>"}`), and the result arrives.

## G6. A plugin changes a builtin harness

A user plugin can change a builtin harness, for example the binary it runs: `vibest harness list` shows the changed
definition as startable, and the next `vibest run` of that harness starts that binary. Removing the plugin restores the
builtin harness.

## G7. A plugin adds a runtime

A user plugin can add a terminal runtime and route an agent to it; the agent starts there and its result arrives.

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
active without editing the plugin or restarting vibestd. An `exports` entry that resolves outside the plugin folder is
not loaded, and the plugin is not listed.

## G11. A plugin disabled by a failing transform

A plugin whose transform throws is disabled and listed as failed with the error. A reload caused by another plugin
does not set it up again; editing the plugin itself does.

## G12. A plugin observes the ledger's facts

A plugin that subscribes with `ctx.event.subscribe` to `session.inbox.enqueued`, `session.created`, `session.execution.started` and
`session.execution.succeeded` gets those facts of a real Pi subagent, in that order, and none it did not ask for. A plugin that
subscribes to every fact gets only public facts (`PublicEvents`: `project.*`, `session.*` including `session.execution.*` and public `session.inbox.*`, and `machine.added` / `machine.removed` — excluding `process.*`, internal bookkeeping/transport facts, and ephemeral events). After the plugin is edited, the new revision gets the next agent's
facts and the old one gets nothing more.

## G13. A plugin written with Promises

A plugin defined as `{ id, setup }` with Promises loads like an Effect plugin: its `session.start.before` callback routes
`vibest run -- <task>` to a real Pi and `vibest ls` names it as the decider, its `event.subscribe` iterator gets the
agent's `session.execution.succeeded`, and deleting its file unloads it and runs the cleanup its `setup` returned. Editing an Effect
plugin into the `setup` form reloads it like any edit (G2).

## G14. A builtin plugin can be removed

`"-<id>"` in `vibest.json` removes the builtin plugin with that exact id (for example `"-vibest.harness-default"`); `"-*"` and
`"-prefix.*"` never match builtins. The removal counts from the config text as soon as vibestd starts. While user plugins
are still importing, a start is refused with `PluginsNotActive`, naming the plugins still loading, and does not run on
a partial set. Once they are active, `vibest plugins` shows the builtin gone, and deleting the line brings it back
without restarting vibestd.

## G16. Moving a plugin keeps it running

A plugin is identified by its declared id and the content of its files, not by where the folder is. Moving an unchanged
plugin folder and updating `vibest.json` to the new path does not set it up again; `vibest plugins` lists it under the
new path. Changing its declared id makes it a new plugin.

## G17. A plugin reads sessions and sends a message

`ctx.session.get` and `ctx.session.list` give a plugin a session's id, title, parent, status and its latest ended
execution with how many messages the session sent during it: 0 for a subagent that only replied, 1 for one that ran
`vibest send` once; `ctx.session.sentIn` gives that count for any execution of a session. `ctx.session.send` queues a message from the plugin itself: the recipient's model sees it in a
`<vibest-message>` naming the plugin, and the inbox row's sender is the plugin. A repeat with the same `request` queues
nothing more, and a message to an archived subagent goes to the session that started it.

## G18. A reminder when a subagent's execution sends nothing

vibest ships the plugin `vibest.report-reminder`, not loaded by default; writing its id `"vibest.report-reminder"` in
`plugins` of `~/.vibest/vibest.json` turns it on. Then, when a subagent's execution completes without the subagent
sending a message, the session that started it receives one message from the plugin ("Message from Vibest ·
vibest.report-reminder") naming the subagent and the execution. A subagent that sent a
message during the execution, an entry session, and a failed or interrupted execution get nothing. An execution that
ended while the plugin was not loaded, or while vibestd was restarting, is reported once when it loads: the plugin
checks each session's latest execution then. Without the plugin, nothing is sent. A message the subagent sends to a
session it started on another machine does not count as sending: it is not a report to the session that started it.

## G19. A config file created after vibestd started

Creating `vibest.json` after vibestd is already running loads the plugin file it names, outside the plugins folder,
without a restart: `vibest doctor` lists that plugin as active, and vibestd is the same process. Editing that file
reloads it the same way, and `vibest doctor` lists the new plugin.

## G20. Stopping idle subagents

vibest ships the plugin `vibest.idle-stop`, not loaded by default; writing `"vibest.idle-stop"` in `plugins` of
`~/.vibest/vibest.json` turns it on, and `{ "package": "vibest.idle-stop", "options": { "idleMinutes": <n> } }` sets how
long a session must be idle (30 minutes by default). It looks at the running sessions every few minutes (every
`idleMinutes` when that is shorter) and stops, as `vibest stop` does (S66), each subagent idle that long: no
execution open, nothing it sent or was sent still waiting. The process's end is recorded as stopped by the plugin, and
the session that started it receives one message from the plugin: "<title> (<id>) was idle for 30 minutes and was
stopped. Send it a message with vibest send to resume it; archive it with vibest archive when you no longer need it."
The plugin checks again at the moment it stops a session, and a session that did anything in between, or now has an
execution open or a message waiting, keeps running and its creator hears nothing. The entry session, a session with an
open execution, and a session started from another machine (its creator is not on this machine) keep running. The
plugin keeps no state of its own: it reads each session's last activity, so a vibestd restart changes nothing.

## G21. A plugin guards tool calls with `session.tool.execute.before`

Both an Effect plugin and a Promise plugin can register `ctx.session.hook("tool.execute.before", ...)`. Each receives `{ session, tool, input, cwd }`, can refuse a tool call with `ToolRefused({ reason })` (surfacing that exact reason to the harness pre-tool hook), and increments `calls` and `refused` in `vibest plugins`. The builtin `vibest.guard` enforces only `VIBEST_SESSION_ID` tampering and direct `vibest-http.sock` requests; other commands are allowed by default unless a plugin refuses them.
