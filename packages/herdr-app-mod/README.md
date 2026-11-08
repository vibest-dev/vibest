# @vibest/herdr-app-mod

A [herdr-app](https://github.com/herdrdev/herdr-app) **0.1.13** panel that lists live vibest sessions. It is a snapshot, not a terminal navigator: herdr-app does not name this window's core, so the panel does not focus anything.

The host types are `~/.config/herdr-app/herdr.d.ts` and `AGENTS.md` from that app (upstream `defaults/AGENTS.md`). This is not a herdr-core plugin and not a legacy Herdr integration (`herdr-plugin.toml`, herdr 0.9.5). `mod.json` uses `place` and `size`. `title` is not a mod key in 0.1.13.

## Read

Shown once, and again on **Refresh**. No timer. The line under the title is the snapshot time. A newer Refresh or `close(cx)` drops an older result. `exec` is limited to 30 seconds and 8 MiB and has no cancel handle (`herdr.d.ts`). An `exec` already started keeps running (`AGENTS.md`). `View.close(cx)` is what the host calls when the copy is removed or the app quits (`gpui-kit.d.ts`). A live window was not used to watch that call.

Each read runs `env -u VIBEST_SESSION_ID -u VIBEST_AGENT -u VIBEST_PROJECT_ID VIBEST_NO_UPDATE_CHECK=1 vibest status`, then, only if that daemon is this vibest, `env -u VIBEST_SESSION_ID -u VIBEST_AGENT -u VIBEST_PROJECT_ID vibest ls --no-start --all-projects`. The three variables are removed so the CLI is the owner, not a session that inherited the app environment. `VIBEST_NO_UPDATE_CHECK=1` is only on `status`: `updateNotice` returns on it, so a curl install or `VIBEST_HARNESSES` does not write `update-check.json` or create a missing home. `ls` does not set that variable. A non-zero `ls`, including an unknown flag, is shown and not retried without the flags.

`status` does not start vibestd. `ls` without `--no-start` does, for a user, when the daemon is down (`withVibest` in `packages/client/src/client.ts`). `--no-start` passes `start: false`. `--all-projects` sends `List` `all: true` from any directory. `--all` still means exited sessions. A session caller stays forbidden. `ls` prints `title`, not `name`. A body that is not that JSON is an error, not a partial list.

Rows show the daemon `status` and `turnState`. A session that is not `hc` on this machine, or whose terminal id has no `@socket`, says so. Every local `hc` row says `core not proven`. Nothing calls `terminals()`, `panes()`, `pane.focus`, or `terminal.keep`.

The runtime is gpui-kit JavaScript. It does not load `@vibest/client`, Effect, or Node.

## Build and check

```sh
pnpm --filter @vibest/herdr-app-mod build
herdr-app check packages/herdr-app-mod
```

`herdr-app check` writes `gpui-kit.d.ts` beside the mod. That file is generated and gitignored. Check does not run the `cx.spawn` read. Copying into `~/.config/herdr-app/mods` is not done here.
