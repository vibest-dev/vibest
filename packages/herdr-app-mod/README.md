# @vibest/herdr-app-mod

A [herdr-app](https://github.com/herdrdev/herdr-app) mod that lists live vibest sessions from vibestd and focuses the terminal the session already runs in.

Checked against the installed app **herdr-app 0.1.13** (`herdr-app --version`). The mod API is the guide and types that app writes on start: `~/.config/herdr-app/AGENTS.md` and `~/.config/herdr-app/herdr.d.ts` (https://github.com/herdrdev/herdr-app, `defaults/AGENTS.md`). This is not a herdr-core plugin and not a legacy Herdr integration (`herdr-plugin.toml` in `docs/design/herdr-surface.md`, herdr 0.9.5).

## What it shows

`exec("env", ["-u", "VIBEST_SESSION_ID", "-u", "VIBEST_AGENT", "-u", "VIBEST_PROJECT_ID", "vibest", "status"])`, then the same for `vibest ls`, with `cwd` set to `appHome()` so the list is every project, not whichever directory the app was started in. `vibest status` does not start vibestd (`apps/vibest-herdr/src/cli.ts`). `vibest ls` runs only after that says the daemon is running, so a stopped daemon stays stopped. The three variables are removed so a Herdr process that inherited an agent environment is not treated as that session (`List` is refused for a session caller).

Each row is daemon truth from `List`: project, session id, name, harness, `status`, and `turnState`. Nothing is read from the terminal screen. Herdr's own agent status (`agents()`) is not shown.

A click focuses that session's existing herdr-core terminal. vibestd stores the terminal as `<address>@<socket>` (`packages/runtime-herdr-core/src/terminal-runtime.ts`, `terminalId`). The address is matched to `terminals()` from this window (`hc` `terminal.list`). If that terminal's `vibest.session` label names a different session, the row does not focus it. The click then does what the shipped peek mod does (`defaults/mods/peek/main.js`): `pane.focus` `{terminal}` when a pane already shows it, otherwise `terminal.keep` `{terminal}` (`herdr-app commands`: "Give a running terminal without a pane (a sub-agent) a pane"). It never calls `terminal.open`. A legacy Herdr pane id is not an address in this window, so the row says it is not here.

The mod runtime is gpui-kit JavaScript (`main.js`, `mod.json`). It cannot load `@vibest/client`: there is no Node, and `net.connect` is TCP only (`gpui-kit.d.ts`). `fetch` is HTTP, not vibestd's Unix socket.

## Build and check

From the repository:

```sh
pnpm --filter @vibest/herdr-app-mod build
herdr-app check packages/herdr-app-mod
```

`herdr-app check` loads the mod once and renders it. It does not install it. It writes `gpui-kit.d.ts` beside the mod for the editor; that file is generated and not part of this package. The first render does not call `vibest`; the read is started with `cx.spawn`, which check does not run (`AGENTS.md`, "Check before you finish").

To show it, copy this directory to `~/.config/herdr-app/mods/vibest` (or `$HERDR_APP_HOME/mods/vibest`) yourself. The first time Herdr sees the folder it docks one copy on the right (`mod.json`). Saving a file reloads it. This package does not write that directory.

`herdr-app check` is not a check that the panel is focused in the running window. A live window still needs `herdr-app status` and a screenshot after the copy, which this package does not do.
