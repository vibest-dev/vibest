# vibest herdr plugin

herdr runs these entrypoints. Each one executes `vibest herdr <verb>`. vibest reads `HERDR_PLUGIN_CONTEXT_JSON` and uses that focused pane or workspace directory as the Project. It does not use the plugin directory, which is the process's working directory.

vibest does not link or enable this plugin. Registration is global for your user, so you do it yourself.

## Link

From a checkout:

```sh
herdr plugin link /absolute/path/to/apps/vibest-herdr/herdr-plugin
```

From a curl install, the directory is unpacked next to `bin/` and `harnesses/` and is not linked:

```sh
herdr plugin link ~/.local/share/vibest/versions/<version>/herdr-plugin
```

`vibest` must be on the herdr server's `PATH`. `VIBEST_BIN` overrides the executable. Undo with `herdr plugin unlink vibest`.

## Keybindings

herdr 0.9.5 has no keybindings in the plugin manifest. Actions are `vibest.<action>` (`open-main`, `run`, `stop`, `runs`, `subscriptions`, `palette`). Add any you want to your own herdr `config.toml`. These chords are examples; pick ones you do not already use:

```toml
[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "vibest.open-main"

[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "vibest.run"

[[keys.command]]
key = "prefix+x"
type = "plugin_action"
command = "vibest.stop"

[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "vibest.runs"

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "vibest.subscriptions"

[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "vibest.palette"
```
