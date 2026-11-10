# Plugins

vibestd loads plugins from the vibest home's plugins folder and from `vibest.json`. Each capability below says what it
is and when it counts as working.

## G1. Listing plugins

`vibest plugins` lists a plugin from the plugins folder and one named in `vibest.json`, both active with zero counters.

## G2. Reloading an edited plugin

Editing a plugin file reloads it without a daemon restart: `vibest plugins` shows the new version, and vibestd is the
same process.

## G3. A plugin that fails to load

A plugin that throws while loading is listed with its error, and the other plugins stay active.

## G4. A plugin refuses a run

A plugin hook that refuses a run blocks `vibest run` with its reason before any pane or worktree exists: the command
fails and prints the reason.

## G5. A routing plugin picks the harness

A plugin can pick the harness for `vibest run`. Without it, a run that names no harness and has nothing to inherit
fails saying there is no harness to inherit; with a plugin that picks Pi, the same run starts a Pi session, `vibest ls`
names the plugin as the one that decided the harness, and the result arrives.

## G6. A plugin changes a builtin harness

A user plugin can change a builtin harness, for example the binary it runs: `vibest harness list` shows the changed
definition as startable, and the next `vibest run` of that harness starts that binary. Removing the plugin restores the
builtin harness.

## G7. A plugin adds a runtime

A user plugin can add a terminal runtime and route an agent to it; the agent starts there and reports its status from
it.
