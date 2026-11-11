# herdr surface for vibest (herdr 0.9.5)

Findings for plan phases 4 (placement and presenter), 8 (herdr plugin), and 9 (machines), and architecture
§10, §11, §12, open questions 3 and 5. Checked on 2026-10-31 against the installed `herdr 0.9.5` (protocol 22)
and the herdr source at tag `v0.9.5` (`/tmp/github.com/herdrdev/herdr`, docs in
`docs/next/website/src/content/docs/`).

**Verified** means run against a live server: a named test session (`vibest-surface-probe`, stopped and
deleted afterwards) for placement and metadata, and a fully isolated server (`XDG_CONFIG_HOME` and
`XDG_STATE_HOME` in a temp directory) for the plugin, with a fake `vibest` that logs its arguments and
environment. **Documented** means read in the herdr docs or source and not run. **Assumed** means neither.

Testing note: inside herdr the shell has `HERDR_SOCKET_PATH` set, and the herdr CLI prefers it over
`XDG_CONFIG_HOME`, so `herdr plugin link` in "isolation" still reached the user's default server and its
`plugins.json`. Tests that isolate herdr must unset `HERDR_SOCKET_PATH` (and the other `HERDR_*` variables) and
pass `--session`. (This happened once during this study and was reverted at once: `plugin unlink vibest` on the
default server, the empty `plugins/config/vibest` directory removed, no plugin command ran.)

## 1. Placement (phase 4)

| Question                                                                             | Answer                                                                                                                                                                                                                                           | Evidence                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Open a subagent as a tab in an existing workspace, cwd in a vibest-made git worktree | Yes: `tab.create { workspace_id, cwd, label, env, focus }`                                                                                                                                                                                       | Verified: tab `w1:t2` in workspace `w1` (cwd = main checkout), cwd = linked worktree, `pwd -P` in the pane is the worktree |
| Environment for the agent                                                            | `env` on `tab.create` reaches the root pane's shell                                                                                                                                                                                              | Verified: `VIBEST_AGENT_ID`, `VIBEST_RUN_ID` echoed in the pane                                                            |
| Environment after a herdr server restart                                             | **Lost.** Restored panes start a new shell without the creation `env`                                                                                                                                                                            | Verified: `ENV=[]` after stop and start                                                                                    |
| Pane ids after a server restart                                                      | Kept (`w1:p2`, `w1:p4`)                                                                                                                                                                                                                          | Verified                                                                                                                   |
| Pane ids past `p9`                                                                   | Carry uppercase, which an agent name must not: agents are named after the vibest session (`s-<id>`), not the pane                                                                                                                                | Verified (runtime-herdr test)                                                                                              |
| Start the agent                                                                      | `agent.start { name, kind, pane_id, args }` into the tab's root pane                                                                                                                                                                             | Documented (schema); omac already uses it                                                                                  |
| Prompt a just-started agent                                                          | `agent.prompt` fails `agent_not_ready` while the `agent.start` launch is pending; herdr marks the agent ready only when `agent.get` reads it after the settle delay, so each try reads it first                                                  | Verified (runtime-herdr test)                                                                                              |
| Worktree grouping                                                                    | herdr groups worktrees at **workspace** level only: `worktree.create/open` make a new workspace grouped under the source workspace. A tab whose cwd is a worktree is not linked: `worktree list` shows that worktree with no `open_workspace_id` | Verified                                                                                                                   |
| Close the last pane of a main checkout's workspace                                   | Closes the whole worktree group, the linked worktrees' workspaces too, so vibest first moves that pane into a workspace of its own; a linked worktree's workspace, or one without a worktree, closes only itself                                 | Verified (runtime-herdr test)                                                                                              |
| What herdr shows for the tab                                                         | The tab label (any text, e.g. `reviewer · claude`) in the tab bar and the `tab` token of Agent rows; the Agent row shows the agent name, or `display_agent` when reported                                                                        | Verified (tab label, pane fields); rendering in a client not observed (headless)                                           |

Pane metadata (`pane.report_metadata`, CLI `herdr pane report-metadata`):

- Fields: `pane_id`, `source` (required), `title` / `clear_title`, `display_agent` / `clear_display_agent`,
  `state_labels` (keys `idle|working|blocked|done|unknown`) / `clear_state_labels`, `tokens` (string sets, `null`
  clears), `agent` and `applies_to_source` (guards for presentation fields only, not tokens), `seq` (stale
  reports from the same source ignored), `ttl_ms` (1 to 86 400 000). Verified: all fields set on a plain shell
  pane (no agent needed) and returned by `pane.get`.
- Limits, verified: at most **16 tokens per report** (`invalid_metadata_token`), at most **32 tokens per pane**
  (`metadata_token_limit`, the whole report is refused), values silently **cut to 80 characters**. Documented:
  token names `^[A-Za-z0-9_-]{1,32}$`; at most 32 distinct sequenced sources per pane for its lifetime.
- Display only: status, waits, notifications, and rollups still come from herdr's semantic state.
- **Not restored** after a server restart (verified: tokens and `display_agent` gone). Republish from vibestd.

Workspace tokens (`workspace.report_metadata { workspace_id, source, tokens, seq, ttl_ms }`): same token
contract, verified (`project=shop`, `runs=2 running` returned by `workspace.get`), also lost on restart. Changes
emit `workspace.metadata_updated` to API subscribers (not to plugin event hooks). Pane tokens render as
`$name` in Agent sidebar rows, workspace tokens in Space rows, but only in rows the user adds to their
`config.toml` (built-in rows do not show custom tokens).

Notifications (`notification.show { title, body, position, sound: none|done|request }`): title cut to 80
characters, body to 240. Verified: with no attached client herdr answers `{"shown": false, "reason":
"no_foreground_client"}`, so vibest must not treat a notification as delivered.

Agent view (`agent.view.set { source, filter, sort }`, open question 5): documented. One view per server; a
set atomically replaces the previous one whatever its owner; plugins must use `source = "plugin:<id>"`; the view
ends when cleared, replaced, the plugin is disabled, or the server exits. `agent.view.clear` can be guarded by
source. Filters can use `{"token": "run"}`, so "this Run" is expressible.

## 2. herdr plugin (phase 8)

Manifest `herdr-plugin.toml` (documented, and verified by linking the draft in an isolated server):

- Top level: `id` (letters, digits, `.:_-`), `name`, `version`, `min_herdr_version` (required in practice:
  linking is refused if newer than the binary), `description`, `platforms`.
- `[[build]]` (GitHub install only, not `link`), `[[startup]]`, `[[actions]]` (`id`, `title`, `description`,
  `contexts` = `global|workspace|tab|pane|selection`, `platforms`, `command` argv), `[[events]]` (`on` = a herdr
  event, `command`), `[[panes]]` (`id`, `title`, `placement` = `overlay` (default) `|popup|split|tab|zoomed`,
  `width`/`height` for popups, `command`), `[[link_handlers]]` (`pattern` regex, `action`).
- Unknown keys are ignored (no `deny_unknown_fields`). Commands are argv, never run through a shell.
- **No keybindings in the manifest.** The user adds `[[keys.command]] type = "plugin_action" command =
  "vibest.<action>"` to their own `config.toml` (§11 rule: only under the user-file mutation rule).
- **No command palette in herdr 0.9.5.** Plugin actions are reachable through keybindings, `herdr plugin action
  invoke`, and the API; `contexts` is stored metadata and herdr shows no action menu. (The
  `command.invoke` API is the herdr-app client-shell catalog, not for plugins.) vibest's palette is therefore its
  own popup pane listing the `command` catalog, as §11 already says.
- Actions cannot open panes by themselves; an action command calls `herdr plugin pane open --plugin <id>
  --entrypoint <pane>`. Verified: action `runs` opened the overlay pane `runs`, which ran `vibest herdr runs`.
- Popups run without an attached client (verified, `type: ok`); they get no `HERDR_PANE_ID` and return
  `ui_busy` while another herdr modal is open (documented).
- Plugin panes start in the plugin root as cwd (verified). vibest must take the Project directory from
  `focused_pane_cwd` / `workspace_cwd` in the context, not from its cwd.
- vibest's actions (`vibest herdr <verb>`): `run` reads a one-line prompt (a multi-line one is `vibest run`);
  `stop` interrupts the execution of the subagent in the focused pane, its session, pane and worktree kept (archive is
  `vibest rm`); `open-main` focuses the main agent only on the plugin's own herdr server, and otherwise starts it
  the way `vibest` does. An agent may not run them (it would run inside its sandbox).
- `vibest` outside herdr opens a tab in the repository's parent workspace and types `vibest --in-parent <root>`
  there, which runs in place without asking herdr: herdr does not report a just-created workspace as the parent,
  so asking would open another one, without end.

Environment, verified with the fake `vibest`: `HERDR_PLUGIN_ACTION_ID` (actions), `HERDR_PLUGIN_ENTRYPOINT_ID`
(panes), `HERDR_PLUGIN_EVENT=startup` (startup hook), `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and
`HERDR_PLUGIN_CONTEXT_JSON`, e.g.

```json
{
  "workspace_id": "w1",
  "workspace_label": "shop",
  "workspace_cwd": "/…/repo",
  "tab_id": "w1:t1",
  "tab_label": "1",
  "focused_pane_id": "w1:p1",
  "focused_pane_cwd": "/…/repo",
  "focused_pane_status": "unknown",
  "invocation_source": "cli",
  "correlation_id": "cli:plugin"
}
```

Source fields also include `worktree` (repository key, root, checkout path, linked flag), `focused_pane_agent`,
`selected_text`, `clicked_url`, `link_handler_id`. Documented: `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`,
`HERDR_ENV=1`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`.
Commands otherwise inherit the herdr **server's** environment (verified: `VIBEST_BIN` set on the server reached
the plugin), so `vibest` must be on the server's `PATH`.

Startup hooks: verified, `[[startup]]` ran once when the isolated server started, with the full context. Run
again on live handoff; not on client attach, config reload, link, or enable (documented). One-shot, not a
supervised daemon.

Install and enable (documented; never run against the user's config):

- `herdr plugin link <absolute path> [--disabled]` registers a local directory; `herdr plugin install
  owner/repository/subdir [--ref] [--yes]` clones from GitHub, previews, runs `[[build]]`, registers.
- Registration is **global for the user** (`$XDG_CONFIG_HOME/herdr/plugins.json`), across every herdr session,
  and works with no server running. `link` creates `plugins/config/<id>` and `plugins/state/<id>`.
- `enable`, `disable`, `unlink`, `uninstall`, `list`, `action list|invoke`, `log list`, `pane open|focus|close`.

## 3. Machines (phase 9, open question 3)

Verified read-only against the user's saved machines (`herdr machine status --json`: both reachable):

- `herdr --machine voyracloud status server` and `agent list` returned the remote server (0.9.5) and its live
  agents. `herdr --machine macbook-pro-m1 …` failed: "remote Herdr does not support machine API forwarding;
  update Herdr on this machine". Mutating remote commands (`tab create`, `agent start`, `agent prompt`) were not
  run on the user's machines.
- Documented as forwarded: `workspace`, `worktree`, `tab`, `pane`, `notification`, `agent` (not `attach`),
  `api snapshot`, `status server`, API-backed `plugin` commands, some `server` commands. Not forwarded:
  `events.subscribe` has no CLI, plugin install, sessions, integrations.
- How it works (source `src/cli/target.rs`, `src/remote/saved.rs`): each CLI call starts an SSH child running
  `herdr --session <s> remote-api-bridge` on the remote host and talks JSON lines over its stdio. IDs are per
  server; `--current` and local pane ids never apply; remote paths must be absolute or `~`.
- Verified locally: `herdr --session <s> remote-api-bridge` carries a streaming subscription
  (`subscription_started`, then a `tab_created` event). The socket, like the bridge, answers **one request per
  connection** (a second request on the same connection got no reply), so the bridge is one SSH process per
  request plus one long-lived SSH process per subscription.
- The UI combines agents of all connected machines, with a `machine` token in default Agent rows; the agent view
  filter applies across machines.

So: **herdr reaches a remote runtime, but not a remote vibest.** A local daemon can start, prompt, read, and
watch agents on a saved machine through `herdr --machine` (or by spawning `ssh <target> herdr --session <s>
remote-api-bridge` itself for subscriptions). vibest still needs:

1. **A way back from the remote machine.** Harness integrations (hooks, `vibest send`, the guard) run on the
   remote host and must reach vibestd: a remote `vibest` with a reverse SSH tunnel to the daemon socket, or a
   small machine agent. herdr gives nothing here.
2. **Workspace types on the remote filesystem**: `worktree.create` is forwarded, but repository copies
   (`project create --from`), the `isolated` type's cleanup, and git state in results need remote file and git
   access (SSH commands or the machine agent).
3. **Harness setup per machine**: CLIs, their logins (Subscriptions, D10), and the vibest harness plugins
   (`harnesses/`, loaded at launch) installed on the remote host.
4. **Offline detection**: `herdr machine status --json` (`reachable`) plus SSH failures map to Machine offline;
   herdr never retries a failed request.
5. **Minimum remote herdr**: one that supports API forwarding (0.9.5 does; the older one here does not).

Proved by E2E M7 (isolated `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` and sessions on both sides, a fake
`ssh` that runs B's commands in B's environment): `herdr machine list --json` is an array of `{id, label, target,
session, enabled, selected}` with the target as typed (`b-host`); a non-interactive `machine add` against a ready B
exits 0 ("Saved SSH machine … Remote server is ready."), against a host without herdr exits non-zero and saves
nothing, and against a session whose server is not its own session leader (`herdr server` started from a shell)
exits 1 with "remote server is not ready for saved machines; machine was not saved" and stops nothing; a session that
vibestd started with `herdr server --session default` spawned detached (`setsid`, for an agent `run --machine`
opened there) reports `detached_server_daemon: true` in `herdr status server --json`, and the saved machine keeps
reaching it after it is stopped and vibestd starts it again; `herdr --machine
<label-or-id> agent get <name>` reaches B's agent. herdr's ssh calls are `ssh -C -F <its config> -S
<control path> -o ControlMaster=auto -o ControlPersist=600 -T <target> …`, with options after the target too, and
scripts on stdin through `/bin/sh -s`. vibest mirrors its machines into these saved machines:
[multi-machine.md](multi-machine.md#terminals-on-other-machines).

## 4. Recommendations

**runtime-herdr placement.** Subagents open as **tabs in the Project workspace** (the main Agent's workspace):
`worktree` for the checkout is made by vibest (`plugin-git`), then `tab.create { workspace_id, cwd: worktree,
label: "<definition> · <harness>", env }`, then `agent.start` into the root pane. Do not use herdr's
`worktree.create`: it makes a separate grouped workspace, which splits the Project across sidebar rows and would
need its own cleanup. Because env is lost on restart, the agent's identity must live in vibest's database
(`runtime.address` = pane id, checked with `pane.get` cwd after a restart), never only in env.

**Presenter.** Source `vibest` (with `seq`), no TTL for durable labels:

- pane: `display_agent` = `<definition> · <harness>`, `title` = task summary, `state_labels.blocked` =
  `waiting for you`, tokens `definition`, `run`, `subscription`, `machine` (≤ 8 tokens, leaving room for other
  plugins inside the 32-per-pane cap; values pre-cut to 80 characters);
- workspace: tokens `project`, `runs` (live Run count);
- `notification.show` on results, `blocked`, limits, reading `shown`; when `false`, rely on the sidebar state;
- republish all metadata on the plugin's startup hook and on vibestd start, since herdr restores none of it;
- agent view (open question 5): set only on an explicit user action (`plugin:vibest` source), clear with the
  source guard, never set automatically; it is a shared single slot.

**Plugin.** Draft in `packages/cli/herdr-plugin/` (`herdr-plugin.toml`, `bin/vibest.sh`): actions
`open-main`, `run`, `stop`, `reschedule`, `runs`, `subscriptions`, `palette`; panes `run` and `palette` (popups),
`runs` and `subscriptions` (overlays); one startup hook. Every command execs `vibest herdr <verb>`; vibest reads
`HERDR_PLUGIN_CONTEXT_JSON`. This needs a `vibest herdr` command group (herdr-product only, D14): `startup`
(republish metadata), `open-main`, `run`, `stop`, `reschedule`, `runs`, `subscriptions`, `palette`, each resolving
the focused pane to its Agent and Run through the daemon. Ship the directory in the npm package (`files`) and
link it with `herdr plugin link` from `vibest` setup, with consent, since registration is global for the user.
Keybindings are a documented snippet the user adds (or vibest adds under the user-file mutation rule).

**Machines.** Use herdr saved machines as the **runtime** transport (`MachineTransport` for the Runtime port:
one `remote-api-bridge` SSH process per request and per subscription, the same JSON as the local socket), and
decide separately the **vibest-side** transport for hooks and Workspace types. Smallest option: install `vibest`
on the remote host and give it `VIBEST_DAEMON` over an SSH reverse-forwarded socket, so hooks and `vibest send`
work unchanged, and run Workspace type steps as SSH commands. A machine agent is only needed if that proves too
fragile.

## 5. Blockers and open items

- Tab env and all metadata are lost on a herdr server restart; vibest must re-identify panes from its database.
- herdr has no plugin command palette and no manifest keybindings; both are vibest work or user config.
- Remote placement and prompting were not exercised (no test machine that may be changed); one saved machine
  needs a herdr update before `--machine` works.
- `agent.start` into a `tab.create` pane and how `display_agent` shows next to a herdr-detected agent in a real
  client were not observed (headless server only).
- `packages/cli/package.json` `files` does not include `herdr-plugin` yet (not changed here).

## 6. How runtime-herdr drives herdr

- **Terminal ids.** A terminal is `<herdr session>/<pane id>`, plus `/<agent name>` when `open` started its agent.
  Pane ids repeat across sessions and are reused after a close, so the agent name keeps a reused pane from being
  taken for the earlier terminal's agent. A named terminal is only the agent `open` named while it still sits in that
  pane; an unnamed one (the main agent, whose harness a shell ran) is the agent herdr detected holding the pane, never
  a named one. A pane another agent holds is never closed or read as this terminal: `state` answers `not_found`,
  which core reads as absent. `Machine.target` is the caller's herdr location as JSON, read only by runtime-herdr.
- **Agent names.** A vibest session's agent is `s-` and the first 30 hex digits of its id (herdr allows
  `[a-z][a-z0-9_-]{0,31}`), so `herdr agent list` shows which session runs where; any other agent `open` starts is
  `vbt-` and random hex. Never the pane id: it is reused and carries uppercase (`w1:pC`). herdr's `done` is `idle`.
- **open.** An agent another machine started (`remote`, from `Peer.Spawn`) opens in herdr's default session `default`
  (`DEFAULT_SESSION_NAME`, also what `herdr machine add` uses without `--remote-session`), never beside a pane, so the
  machine that started it can save that session as a herdr machine. Otherwise the session is `near`'s, else the
  caller's location, else `HERDR_SOCKET_PATH`, else `vibest`. A missing session is started with `herdr server
  --session <s>` spawned detached, so the server is its own session leader, as herdr saved machines require. `near`
  places the terminal only while its pane exists; a stale one (closed while vibestd was down, or herdr restarted)
  falls back to the Project's workspace: the checkout's worktree group, else a workspace with a pane at that path
  (symlinks resolved), else a new one. `tab.create` and `pane.split` are the only places env can be set. A command
  that is not a harness is typed into the shell after it drew (up to 30 s), not exec'd, so the terminal stays at
  its shell and `run` can start another there. Anything that fails after the pane exists closes it again: core only
  closes what `open` returned, and a harness that dies at start (its usage limit, a bad flag) must not leave an
  empty shell.
- **agent.start.** herdr types the harness once the shell is idle. After a harness exits herdr keeps its name on
  that pane until it sees the agent gone, so `agent_name_taken` on the same pane and `agent_pane_busy` are retried
  (40 times, 500 ms apart). Without herdr's integration for that harness a start never settles; the error and
  `vibest doctor` point at `herdr integration status` and `herdr integration install <harness>`.
- **send.** herdr refuses `agent.prompt` (`agent_not_ready`) until it marks the agent ready, and it marks it only
  when something reads it (`agent.get`), never on `agent.prompt`; a harness that reports its own state (herdr's Pi
  hook) sends no further event once idle. A prompt sent before the mark works, but herdr then drops the name when
  `agent.start`'s timeout passes unmarked, and the terminal reads as exited while its harness works. So each try
  reads the agent and then prompts, for about 30 s; an agent never marked gets the text as one bracketed paste and
  Enter (`pane.send_input`), as `agent.prompt` sends it. `pane.send_text` reaches a TUI as keystrokes in chunks,
  and a long multi-line text loses its first chunks.
- **run.** A harness in a named terminal goes through `agent.start` again. Any other command is typed only once
  every foreground process of the pane is a shell: its own, or one a wrapper left (`sh -c '"$@"; exec $SHELL'`).
  `process` counts as running anything in the foreground besides the pane's shell, and a named agent whose launch is
  still pending: the shell may still be starting, so no agent process exists yet, and a reconcile must not read that
  pane as exited. A pane `process_info` cannot find is `not_found`, so a closed pane is still seen at once. Commands
  are typed as POSIX shell words (`shellQuote`); fish reads backslashes inside single quotes as escapes, so such an
  argument is misread there.
- **close.** herdr closes a workspace with its last pane, and a main checkout's workspace takes its linked
  worktrees' workspaces with it. So the last pane of a workspace that is not listed, or whose worktree is a main
  checkout, is moved alone into a workspace of its own first; a workspace without a worktree closes at most itself.
  The pane is read again right before the close, so a sibling closing in the gap cannot turn it into a group close.
- **state and events.** One subscription per pane: `pane.agent_status_changed` gives `state`, and
  `pane.agent_detected` with no agent gives `exited` (the program ended, the pane stays at its shell).
  `pane.agent_detected` has no pane filter, so its frames are picked by `pane_id`; a subscription frame names its
  kind in `event`, a workspace event in its data's `type`. `pane_closed` and `pane_exited` on the session's broadcast
  are `exited` too. A herdr restart ends every pane subscription and is published as `reset`; core then reads each
  terminal's `state` once, which subscribes again. A row from before this vibestd teaches the name its events carry
  once its agent is found in the pane. `state` is herdr's status for a detected agent, and for one `open` started
  only once it is `interactive_ready`.
- **present.** Pane tokens for the session, workspace tokens for the Project; other keys are left alone. `seq` is
  `max(now, last + 1)`: herdr keeps a source's seq until it restarts and drops a report that is not newer.
- **The pool.** One vibestd talks to every herdr session on the machine. Rows store the session name; `herdr
  session list --json` maps it to a socket. Each session gets one broadcast subscription, handshaken on every
  connect (a live handoff can swap the server under a running vibestd), reconnected at once after a clean close and
  with backoff (1 s doubling to 30 s) after failures. Every connect after the first is a restart: herdr restored the
  panes and dropped their metadata. A named session that is not running is started headless (`herdr server
  --session <name>`, detached, so it outlives vibestd).
- **The caller.** Inside herdr its location is its own socket (`HERDR_SOCKET_PATH`), else a session name (`vibest`);
  `--session` wins. Its terminal is `<session>/<HERDR_PANE_ID>`, the session found by its socket in `herdr session
  list`. A harness may hand its shell less environment than it got, so `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` are
  passed on explicitly (`CALLER_ENV`).
- **The plugin.** `runtime-herdr` builds its own platform (socket dialing, file system, child processes), so it
  loads in any host that runs the plugin API; its pool lives in the plugin's scope and closes with it. `doctor`
  asserts the type of the spawner's output, since `spawner` is typed by its tag.

## 7. effect-herdr-sdk

- **Wire** (protocol 22): newline-delimited JSON, `{id, method, params}` → `{id, result}` or `{id, error}`; the
  server closes after one response, so every call is its own connection. A response with `id: ""` means the server
  could not parse the request; it is still ours. `events.subscribe` answers first and then streams `{event, data}`
  frames on the same connection, so no ack state is needed.
- **Trust.** Results and frames are not decoded at runtime: the generated types, and the casts that hand them out,
  hold only for the protocol they were generated from. Every consumer runs `Herdr.verifyProtocol` once per server.
- **Sockets.** The reader is acquired before the writer: acquiring the reader dials, and the writer waits on it. A
  close surfaces as a `SocketError`; a clean close ends the stream. `src/bun.ts` is the only file that names a
  runtime; the rest asks for a `SocketConnector`.
- **Socket path.** `HERDR_SOCKET_PATH`, else the deprecated `HERDR_SOCKET`, else `<configdir>/herdr.sock`
  (`<configdir>/sessions/<name>/herdr.sock` for a named session). The config dir mirrors herdr's `config_dir()`:
  `XDG_CONFIG_HOME`; on Windows `%APPDATA%`, then `%USERPROFILE%\AppData\Roaming`; then `$HOME/.config`; then the
  temp dir (`TMPDIR` or `/tmp`; on Windows `TMP`, `TEMP`, else `C:\Windows\Temp`, without GetTempPath's Windows
  directory fallback). A `herdr-dev` debug build is never guessed: pass `dev`. Windows is recognised by `path.sep`, so
  `BunPath.layerWin32` reproduces its rules on any host. On Windows herdr writes only a marker file at the path and
  listens on the named pipe `\\.\pipe\<path>`; a path with a drive or a backslash is dialed there.
- **Generation.** `bun run generate` writes `src/generated` from the schema pinned in `schema/herdr-version.json`;
  `--check` fails when it differs. Each schema namespace is its own module: several type names (`PaneInfo`,
  `TabInfo`, `WorkspaceInfo`, …) differ between the event and response namespaces. `AgentStatus` and `PaneScrollInfo`
  are defined identically in the session and subscription event namespaces, so the events module emits them once. The schema has no method →
  result map (`ResponseResult` is one flat union), so `scripts/gen/method-result-map.ts` was found empirically
  against herdr 0.8.2; a method missing there is typed as the loose union, a typing gap and never a runtime bug.
- **Tests.** `test/client.test.ts` runs against a fake herdr on a temp socket; `test/live.test.ts` against the
  running herdr, only with `HERDR_LIVE` set.
