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

| Question | Answer | Evidence |
|---|---|---|
| Open a subagent as a tab in an existing workspace, cwd in a vibest-made git worktree | Yes: `tab.create { workspace_id, cwd, label, env, focus }` | Verified: tab `w1:t2` in workspace `w1` (cwd = main checkout), cwd = linked worktree, `pwd -P` in the pane is the worktree |
| Environment for the agent | `env` on `tab.create` reaches the root pane's shell | Verified: `VIBEST_AGENT_ID`, `VIBEST_RUN_ID` echoed in the pane |
| Environment after a herdr server restart | **Lost.** Restored panes start a new shell without the creation `env` | Verified: `ENV=[]` after stop and start |
| Pane ids after a server restart | Kept (`w1:p2`, `w1:p4`) | Verified |
| Start the agent | `agent.start { name, kind, pane_id, args }` into the tab's root pane | Documented (schema); omac already uses it |
| Worktree grouping | herdr groups worktrees at **workspace** level only: `worktree.create/open` make a new workspace grouped under the source workspace. A tab whose cwd is a worktree is not linked: `worktree list` shows that worktree with no `open_workspace_id` | Verified |
| What herdr shows for the tab | The tab label (any text, e.g. `reviewer · claude`) in the tab bar and the `tab` token of Agent rows; the Agent row shows the agent name, or `display_agent` when reported | Verified (tab label, pane fields); rendering in a client not observed (headless) |

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

Environment, verified with the fake `vibest`: `HERDR_PLUGIN_ACTION_ID` (actions), `HERDR_PLUGIN_ENTRYPOINT_ID`
(panes), `HERDR_PLUGIN_EVENT=startup` (startup hook), `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, and
`HERDR_PLUGIN_CONTEXT_JSON`, e.g.

```json
{"workspace_id":"w1","workspace_label":"shop","workspace_cwd":"/…/repo","tab_id":"w1:t1","tab_label":"1",
 "focused_pane_id":"w1:p1","focused_pane_cwd":"/…/repo","focused_pane_status":"unknown",
 "invocation_source":"cli","correlation_id":"cli:plugin"}
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

1. **A way back from the remote machine.** Harness integrations (hooks, `vibest report`, the guard) run on the
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

**Plugin.** Draft in `apps/vibest-herdr/herdr-plugin/` (`herdr-plugin.toml`, `bin/vibest.sh`): actions
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
on the remote host and give it `VIBEST_DAEMON` over an SSH reverse-forwarded socket, so hooks and `vibest report`
work unchanged, and run Workspace type steps as SSH commands. A machine agent is only needed if that proves too
fragile.

## 5. Blockers and open items

- Tab env and all metadata are lost on a herdr server restart; vibest must re-identify panes from its database.
- herdr has no plugin command palette and no manifest keybindings; both are vibest work or user config.
- Remote placement and prompting were not exercised (no test machine that may be changed); one saved machine
  needs a herdr update before `--machine` works.
- `agent.start` into a `tab.create` pane and how `display_agent` shows next to a herdr-detected agent in a real
  client were not observed (headless server only).
- `apps/vibest-herdr/package.json` `files` does not include `herdr-plugin` yet (not changed here).
