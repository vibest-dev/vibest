# End-to-end test plan

What `pnpm test` covers today: every module against a fake herdr and fake harnesses. What it does not cover: a real
herdr session, a real CLI agent, real model output, real Claude / Pi / Cursor hook payloads. This plan covers
those, for every omac feature vibest carries.

## 1. Isolation

vibest writes nothing into the user's `~/.vibest`, harness config (`~/.claude`, `~/.pi`, `~/.cursor`) or main herdr session.

| Thing          | E2E value                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOME`         | the user's own: the harnesses' subscription logins live in its keychain, and a temp `HOME` is logged out                                                                                                                                                                                               |
| `VIBEST_HOME`  | a fresh `0700` temp directory per run                                                                                                                                                                                                                                                                  |
| Harness config | temp directories per run through each harness's own variable: `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`, `CURSOR_CONFIG_DIR`. The real-harness turns (I3–I5) use the user's own config, read only, and load vibest's plugin from `VIBEST_HARNESSES`. The user's real files are checked unchanged (I6) |
| herdr session  | herdr keeps its sessions under the real `HOME`: a session vibest starts during the run is stopped at the end; the user's sessions stay                                                                                                                                                                 |
| Repository     | a scratch git repository with a local bare `origin`, so pushed / unpushed / dirty states are real                                                                                                                                                                                                      |
| Binary         | `apps/vibest-herdr/dist/vibest` from this checkout, first on `PATH` (harness plugins run `vibest` from `PATH`), then `~/.local/bin` (cursor-agent)                                                                                                                                                     |
| Credentials    | the user's subscription logins; never printed or written to evidence                                                                                                                                                                                                                                   |

| Harness             | Login                   | Note                                                                                                                |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.314 | subscription (keychain) | `CLAUDE_CONFIG_DIR` keys its login to the config directory: a temp one is logged out, enough for the install checks |
| Pi 1.4.0            | `~/.pi/agent/auth.json` | a temp `PI_CODING_AGENT_DIR` has no login, enough for the install checks                                            |
| Cursor 2026.10.22   | subscription (keychain) | stays logged in with a temp `CURSOR_CONFIG_DIR`; its transcripts still go to the real `~/.cursor/projects`          |

## 2. Layers

**L0, already automated, no keys.** `pnpm test`; `HERDR_LIVE=1 pnpm test` inside a herdr pane (the two live files);
`pnpm verify` runs all of it (build, typecheck, test), installs vibest as a user does (install.sh from a release archive, and npm from the packed `@vibest/cli`), and runs
every script check on that install, a skip failing the run (tools/verify/README.md).

**L1, real herdr, no model.** Every command whose effect does not need a model turn.

| Feature       | Check                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon        | `vibest status` auto-start, `daemon restart`, the lock against a second daemon, `update` replacement with agents working (they keep running)        |
| Protocol      | an old protocol header is refused; caller roles (`VIBEST_AGENT`, `VIBEST_SESSION_ID`) are checked                                                   |
| Project store | `project info/list/read/search/write/delete` with `ifVersion` conflicts, secret refusal, across a daemon restart                                    |
| Plugins       | `plugins` lists a routing plugin; edit it on disk and see the reload; a refusing plugin blocks `run`                                                |
| Integrations  | each harness loads vibest's plugin from the built `harnesses/` (`pi -e`, `--plugin-dir`) beside the user's own; `doctor` without `VIBEST_HARNESSES` |
| Guard         | the hook script denies `vibest rm` / project-store paths for a worker and allows them for the coordinator                                           |
| Models        | `models`, `harness list`, `harness models <each>`                                                                                                   |

**L2, real harness and model.** One matrix row per harness (Claude, Pi, Cursor). Prompts are deterministic:
"create `out-<nonce>.txt` containing `<nonce>`, then reply `DONE-<nonce>`".

| #   | Scenario                                                                          | Pass when                                                                                                                 |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `run` in a new worktree                                                           | pane exists, row `working` → `idle`, file in the worktree, `result` holds `DONE-<nonce>` in the `<agent-result>` envelope |
| 2   | `send` a follow-up                                                                | delivered once (confirm-after-send), turn `completed`                                                                     |
| 3   | `report` from the worker                                                          | the coordinator inbox gets it; same-sender messages merge                                                                 |
| 4   | `interrupt` mid-turn                                                              | turn `interrupted`, pane alive, next `send` works                                                                         |
| 5   | `--peer`, `--in-parent`, `--name`, `--model`, `--provider`, `--headless`, `--env` | each flag visible in the row and the pane                                                                                 |
| 6   | `archive` clean                                                                   | pane closed with PID proof, worktree removed, branch kept                                                                 |
| 7   | `archive` dirty / unpushed / `--keep-worktree`                                    | worktree kept, `reasons` names why                                                                                        |
| 8   | `run --archive-on-completion`                                                     | archived right after the completed result reaches the coordinator                                                         |
| 9   | Self-heal                                                                         | kill the daemon mid-turn, restart: turn ends `lost` or resumes; no blind replay                                           |
| 10  | Startup failure                                                                   | bad model: a failed result with the error, no screen text; `vibest peek <id>` shows the pane                              |
| 11  | Limits                                                                            | `VIBEST_MAX_SESSIONS=1`: the second `run` gets `LimitReached`                                                             |
| 12  | Coordinator                                                                       | `vibest` in the parent workspace, resume after its pane closes, rules file written                                        |

The pattern-level stories that combine these rows are in [e2e-user-stories.md](e2e-user-stories.md).

Claude only: the inbox bridge (`inbox attach/pull/ack/release`) delivers to a live Claude coordinator without paste,
and `integration stop` ends cleanly. Pi only: the coordinator TUI (tool groups, user-message padding) renders in the pane.

## 3. Runner

`tools/e2e` (Bun, private package): one scenario per file, run in sequence, each with a timeout. It writes evidence to
`tools/e2e/evidence/<run>/`: commands, exit codes, `ls --json`, `result`, pane text, and the database. It signals and
closes only the PIDs and panes it recorded. A skipped harness (no key) is reported as skipped, never as passed.

Real-model checks give the agents they have vibest start a model through vibest's own options (`--provider`,
`--model`), chosen in one place (`tools/e2e/src/world.ts` `agentModel`): `VIBEST_E2E_PROVIDER` and `VIBEST_E2E_MODEL`
when set, else Claude Haiku. The checks that start a harness directly (I3–I5) keep their own flags. vibest's Claude
adapter accepts no provider other than `anthropic`, so a provider for the Claude checks is refused by vibest itself.
`VIBEST_E2E_ENV` adds environment for those agents: `KEY=VALUE` pairs, one per line, each passed as vibest's own
`--env`. With `--model` it runs a Claude agent on another Anthropic-compatible endpoint, for example
`VIBEST_E2E_ENV=$'ANTHROPIC_BASE_URL=<endpoint>\nANTHROPIC_AUTH_TOKEN=<token>' VIBEST_E2E_MODEL=<model>`. Unset, nothing
changes. Its values are never printed: console output, failure details and evidence show `<redacted>` instead.

## 4. Cost and time

About 12 short turns per harness on the cheapest model: roughly 50 turns per full run, about 20–30 minutes.
