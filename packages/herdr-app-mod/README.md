# @vibest/herdr-app-mod

A [herdr-app](https://github.com/herdrdev/herdr-app) mod that lists live vibest sessions from vibestd. It does not focus a terminal: herdr-app 0.1.13 does not say which core a `t7` belongs to, and two cores can both have that address.

API: **herdr-app 0.1.13** (`herdr-app --version`). The host calls are the ones in `~/.config/herdr-app/herdr.d.ts` and `AGENTS.md` written by that app (upstream `defaults/AGENTS.md`). This is not a herdr-core plugin and not a legacy Herdr integration (`herdr-plugin.toml` in `docs/design/herdr-surface.md`, herdr 0.9.5).

## Read

The panel reads once when it is shown, and again when **Refresh** is clicked. There is no timer. Herdr re-renders the panel when its own terminals change; the session rows do not. A line under the title is the snapshot time. A newer Refresh, or the copy closing, drops an older result instead of painting it. `exec` is the host's: 30 seconds and 8 MiB (`herdr.d.ts`). The host has no cancel handle, so a closed copy ignores the result and does not start a second timer around the process.

Each read is `vibest status`, then `vibest ls --no-start`, via `exec("env", ["-u", "VIBEST_SESSION_ID", "-u", "VIBEST_AGENT", "-u", "VIBEST_PROJECT_ID", "vibest", ...], { cwd: appHome() })`. `status` never starts vibestd (`apps/vibest-herdr/src/cli.ts`). `ls` without `--no-start` does, when the caller is not a session and the daemon is down (`withVibest` in `packages/client/src/client.ts`). `--no-start` uses that client's `start: false`. The CLI test `vibest ls --no-start does not start vibestd when nothing is listening` checks exit 1, empty stdout, `DaemonUnavailable`, and that the vibest home was not created. A status check before `ls` is not what makes this safe.

`status` on the installed vibest 0.0.1-beta.17, with vibestd already running, exited 0 and printed `daemon.status`, `daemon.version`, `daemon.sameVersion`, `daemon.protocol`, and `client.version`. The CLI test for a dead socket expects exit 0 and `{ daemon: { status: "not running", socket }, runtimes: null }` without creating the home. If `sameVersion` is not true, or `protocol` is missing, the panel shows that and does not list. `ls` prints a JSON array and renames `name` to `title`. `cwd` is `appHome()`, so `List` asks for every project and does not create one. A non-zero exit is shown from stderr (a disappeared daemon is `DaemonUnavailable`). A body that is not that JSON is an error, not a partial list.

Rows show the daemon's `status` and `turnState`, not Herdr `agents()` and not the screen.

## Focus

There is no Focus control. `terminals()` is `hc ls` (address and labels, no socket). `hc()` is not documented as this window's core. `machines()` names a machine, not a socket. herdr-app 0.1.13 has no gateway core id to compare with `<address>@<socket>`. The row says why focus is off, usually `core not proven`.

A later host that passed the window socket could focus only when that socket equals the session socket, `runtime` is `hc`, `address.machine` is `local`, the address has no `/`, exactly one terminal has that address and `vibest.session` equal to the session id, and a pane already shows it. The same `t7` and a copied session label on another socket do not match. The command would be `pane.focus` only, read again at click time. This mod does not call it.

`terminal.keep` is not used. herdr-app 0.1.13 says it gives a running terminal a pane, and `AGENTS.md` says it enables core keep and can stay `pending` until the machine applies it. `terminal.open` and `agent.focus` are not used. A remote machine stays "on another machine" even when the socket path text matches. A legacy Herdr id is not an hc address.

The runtime is gpui-kit JavaScript. It does not load `@vibest/client`, Effect, or Node, and it does not open a TCP bridge. `net.connect` is TCP only. `fetch` is HTTP, not vibestd's Unix socket.

This has not been loaded in a running window. `herdr-app check` renders the module once; it does not prove the panel, and it does not prove the read is read-only on a live daemon. The no-start proof is the CLI test above.

## Build and check

```sh
pnpm --filter @vibest/herdr-app-mod build
herdr-app check packages/herdr-app-mod
```

`herdr-app check` writes `gpui-kit.d.ts` beside the mod. That file is generated and gitignored. Check does not run the `cx.spawn` read. Copying into `~/.config/herdr-app/mods` is not done here.
ove.

## Build and check

```sh
pnpm --filter @vibest/herdr-app-mod build
herdr-app check packages/herdr-app-mod
```

`herdr-app check` writes `gpui-kit.d.ts` beside the mod. That file is generated and gitignored. Check does not run the `cx.spawn` read. Copying into `~/.config/herdr-app/mods` is not done here.
