# @vibest/herdr-app-mod

A [herdr-app](https://github.com/herdrdev/herdr-app) mod that lists live vibest sessions from vibestd and focuses a pane that already shows that session's terminal.

API: **herdr-app 0.1.13** (`herdr-app --version` on this machine). The calls below are the ones in `~/.config/herdr-app/herdr.d.ts` and `~/.config/herdr-app/AGENTS.md` written by that app (upstream `defaults/AGENTS.md`). This is not a herdr-core plugin and not a legacy Herdr integration (`herdr-plugin.toml` in `docs/design/herdr-surface.md`, herdr 0.9.5).

## What a read does

The first time the panel is shown, and when **Refresh** is clicked, it runs:

`exec("env", ["-u", "VIBEST_SESSION_ID", "-u", "VIBEST_AGENT", "-u", "VIBEST_PROJECT_ID", "vibest", "status"], { cwd: appHome() })`

`herdr.d.ts` bounds `exec` at 30 seconds and 8 MiB. There is no timer. Herdr re-renders the panel when its own terminals and panes change; the session list does not. The line under the title is a snapshot time, not a watch.

`vibest status` exits 0 and does not start vibestd or create its home. Checked against the installed `vibest` 0.0.1-beta.17 while vibestd was running (JSON `daemon.status`, `daemon.version`, `daemon.sameVersion`, `daemon.protocol`, `client.version`) and against `apps/vibest-herdr/test/cli.test.ts`, which expects `{ daemon: { status: "not running", socket }, runtimes: null }` and an unchanged home when nothing is listening. A status that is not `running`, or whose `sameVersion` is not true, or which has no numeric `protocol`, is shown and `vibest ls` is not run.

`vibest ls` is the same `exec`, with `ls` instead of `status`. The CLI prints a JSON array and renames `name` to `title` (`titled` in `apps/vibest-herdr/src/cli.ts`). `cwd` is `appHome()`, outside a project, so `List` is asked for every project and does not create one. The three variables are removed so an inherited agent environment is not the caller (`List` is refused for a session). `vibest ls` itself starts vibestd when the caller is not a session and the daemon is down (`withVibest` in `packages/client/src/client.ts`). This panel does not call it unless status just said `running`. If vibestd exits in that gap, that start can still happen.

Rows show the daemon's `status` and `turnState`. Nothing is read from the terminal screen, and Herdr's `agents()` status is not shown. A bad status or list (not the JSON above) is an error, not a partial list.

## What a click does

A click runs `pane.focus` `{ terminal }` only when all of these hold:

- `runtime` is `hc` and `address.machine` is `local` (a remote machine is shown as "on another machine", even when its socket path text matches a local one)
- `address.id` is `<address>@<socket>` (`terminalId` in `packages/runtime-herdr-core/src/terminal-runtime.ts`) and the address has no `/`
- exactly one `terminals()` entry has that address and `labels["vibest.session"]` equal to the session id (a label with no matching address does not count; two matches are "ambiguous")
- a model pane from `panes()` already shows that address

`terminal.keep` is not used. herdr-app 0.1.13 describes it as giving a running terminal a pane, and `AGENTS.md` says it enables core keep and can report `pending: true` until the machine applies it. `terminal.open` and `agent.focus` are not used either. A matched terminal with no pane says "no pane to focus".

The mod runtime is gpui-kit JavaScript (`main.js`, `mod.json`). It does not load `@vibest/client`, Effect, or Node. `net.connect` is TCP only (`gpui-kit.d.ts`). `fetch` is HTTP, not vibestd's Unix socket.

## Build and check

From the repository:

```sh
pnpm --filter @vibest/herdr-app-mod build
herdr-app check packages/herdr-app-mod
```

`herdr-app check` loads the mod once and renders it. It does not install it. It writes `gpui-kit.d.ts` beside the mod for the editor; that file is generated and not part of this package. The first render starts the read with `cx.spawn`, which check does not run.

To show it, copy this directory to `~/.config/herdr-app/mods/vibest` (or `$HERDR_APP_HOME/mods/vibest`) yourself. The first time Herdr sees the folder it docks one copy on the right (`mod.json`). Saving a file reloads it. This package does not write that directory.

`herdr-app check` does not prove the panel in a running window.
