# Feature map

Every product capability vibest carries from omac, and how it is proven in a real environment: the built
`apps/vibest-herdr/dist/vibest`, a real herdr, real harness CLIs, a scratch git repository with a local bare `origin`,
the user's own `HOME` (the harnesses' logins) with a temp `VIBEST_HOME` and temp harness config directories (see
[e2e-plan.md](e2e-plan.md) §1). Fakes do not count.

**Method**

- **script**: deterministic; a `tools/e2e` scenario runs it and checks exit status and output. Pass or fail, no judgment.
- **agent**: the outcome depends on a model or on reading a screen; an agent follows the steps in a real environment
  and reports each check with its evidence (commands, output, pane text). A check without evidence is a fail.
- **runtime**: needs the Agent runtime (a CLI agent running a turn). Held until the Agent runtime is decided; listed
  so nothing is forgotten.

A skipped check (missing CLI or key) is reported as skipped, never as passed.

Run the script checks with `pnpm run e2e` (all) or `pnpm run e2e D4 I1` (some) after `pnpm run build`; `pnpm verify`
runs them on a curl and an npm install of this checkout instead, after every other gate. Questions that
only a terminal is asked (`[y/N]`) are answered on a pseudo-terminal. Evidence: `tools/e2e/evidence/<run>/`.
Checks that run a turn on a real model take it from `VIBEST_E2E_PROVIDER` and `VIBEST_E2E_MODEL` when set, passed with
vibest's own `--provider` and `--model`; unset, each keeps its default (S10: Claude `haiku`; S10-pi skips). A Claude
check skips on a provider other than `anthropic`, which vibest does not give a Claude agent.

## Daemon and protocol

| ID  | Capability                                                                                                                                                | Method  | Pass when                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| D1  | `vibest status` without a daemon                                                                                                                          | script  | prints client and "not running", starts nothing                                                          |
| D2  | `vibest daemon` starts vibestd in the background; a second `vibest daemon` exits 0 and starts no second one                                               | script  | one PID in `$VIBEST_HOME`, both commands exit 0                                                          |
| D3  | lock: `vibest daemon --foreground` while one runs does not take over                                                                                      | script  | says already running, exits 0, the first daemon untouched                                                |
| D4  | `vibest daemon restart` when idle replaces vibestd                                                                                                        | script  | new PID, same socket answers                                                                             |
| D5  | protocol: a request without the `vibest-protocol` header, or with an old value, is refused                                                                | script  | `ProtocolRejected`, daemon still answers                                                                 |
| D6  | caller roles: `VIBEST_AGENT` / `VIBEST_SESSION_ID` that do not match a row are refused                                                                    | script  | `InvalidCaller` / `Forbidden`                                                                            |
| D7  | `vibest daemon restart` while agents work replaces vibestd; agents keep running, queued messages are kept; unfinished daemon operations refuse it by name | runtime | `stop.test.ts`, `self-heal.test.ts`                                                                      |
| D8  | `vibest update` with work in flight: replacement waits or names blockers                                                                                  | runtime |                                                                                                          |
| U1  | `vibest update` installs a newer version the way vibest was installed: install.sh again into the same directories, or npm; a build installs nothing       | script  | a local release and registry offer 999.0.0; the installer run is recorded                                |
| U2  | `vibest update` hands vibestd over and restarts an old Pi main agent mid-turn in its own terminal                                                         | script  | same session, conversation and terminal; new harness pid; the turn gets `continue`; results still arrive |
| U5  | a usage-limit move ends only the limited harness and runs the next one in the same pane                                                                   | script  | same pane and session; old pid gone; one round completes on the next login                               |
| U6  | `vibest daemon restart` onto another vibest offers the agents on an old integration and restarts them in place                                            | script  | same pane and conversation; new harness pid; integration version updated                                 |
| D9  | `vibest update` from the registry                                                                                                                         | agent   | needs a published newer beta; the agent checks the prompt, the confirmation and the replaced daemon      |

## Project store

| ID  | Capability                                                              | Method | Pass when                                            |
| --- | ----------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| P1  | `project info` in a repository                                          | script | instructions path and empty kinds                    |
| P2  | `project write/read/list/search/delete` for `docs`, `memory`, `scratch` | script | each round-trips; search hits `kind/path:line: text` |
| P3  | `--if-version` conflict on write and delete                             | script | non-zero exit, entry unchanged                       |
| P4  | secret refusal (a key-like value)                                       | script | non-zero exit, nothing written                       |
| P5  | entries survive `daemon restart`                                        | script | read after restart equals the write                  |
| P6  | path escape (`../`, absolute) refused                                   | script | non-zero exit                                        |

## Plugins

| ID  | Capability                                                                             | Method  | Pass when                                                 |
| --- | -------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| G1  | `vibest plugins` lists a plugin from `$VIBEST_HOME/plugins` and one from `vibest.json` | script  | both listed with zero counters                            |
| G2  | editing a plugin file reloads it without a daemon restart                              | script  | `plugins` shows the new version; same daemon PID          |
| G3  | a plugin that throws at load is reported, others keep working                          | script  | error in `plugins`, the rest listed                       |
| G4  | a refusing `run` hook blocks `vibest run` with its reason, before any pane or worktree | script  | non-zero exit, reason printed, no worktree, no herdr pane |
| G5  | a routing plugin picks the harness for `run`                                           | runtime |                                                           |

## Harnesses and models (harness adapters)

| ID  | Capability                                                                                                | Method | Pass when                                                           |
| --- | --------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| H1  | `harness list`: binary, on PATH, default model, per harness                                               | script | one entry per harness (Claude, Pi, Cursor); a missing CLI says so   |
| H2  | `harness models <harness>` / `models`                                                                     | script | non-empty list for each installed harness; a missing one is skipped |
| H3  | `doctor`: grouped (coding agents, herdr, vibestd, plugins), a fix line under each problem, then a verdict | script | one agent line per harness; a herdr line per usable harness         |

## Integrations (harness adapters)

vibest's plugin for each harness ships in `@vibest/cli` (`harnesses/<harness>`, `VIBEST_HARNESSES`) and is loaded into each
session vibest starts: Pi `-e`, Claude and Cursor `--plugin-dir`. Nothing is installed. The real-harness checks use the
user's own login and config, read only; the user's real config files keep their modification times.

| ID  | Capability                                                                                                  | Method | Pass when                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | the plugins ship with vibest; `integration` is only the hooks' `guard` and `stop`                           | script | each harness's plugin files are in the built `harnesses/`; `integration install` does not exist                                                                                                                                                                                                                                            |
| I2  | the binary alone finds its plugins beside it; no plugins, no harness                                        | script | without `VIBEST_HARNESSES`, `dist/vibest` finds `harnesses/`; a copy with none beside it makes `doctor` name the missing directory for each harness                                                                                                                                                                                        |
| I3  | a real Pi runs vibest's extension from `pi -e`                                                              | script | a vibest agent's `herdr pane list` does not run; its reply is the session's `vibest result`; skipped without pi                                                                                                                                                                                                                            |
| I4  | a real Claude runs vibest's plugin from `--plugin-dir` beside the user's installed plugins                  | script | the init message lists vibest's plugin and the installed ones; the guard's refusal (`tool.call`) is in the transcript and herdr does not run; `turn.complete` is the session's `vibest result`; skipped without claude                                                                                                                     |
| I5  | a real cursor-agent runs vibest's plugin from `--plugin-dir` beside the project's own hooks                 | script | the guard refusal is recorded and herdr does not run; its reply is the session's `vibest result`; the project's `sessionStart` hook ran; skipped without cursor-agent or its login                                                                                                                                                         |
| I6  | the user's own harness config files do not change                                                           | script | real `~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/.pi/agent/settings.json` modification times unchanged (`~/.cursor/cli-config.json` is out: vibest never writes it and cursor-agent rewrites it itself)                                                                                                                          |
| I7  | every Claude main-loop turn end is the plugin's turn.complete: answer, the person's Esc, `vibest interrupt` | script | `vibest run claude` in a herdr session: an answer is a completed result; Esc in the pane is exactly one failed result with "interrupted: the turn was stopped in its terminal (Esc) before it ended"; after `vibest interrupt` the aborted turn.complete reaches vibest (vibestd logs the end), no result; skipped without herdr or claude |
| I8  | `vibest peek <id> [--lines N]` reads a session's terminal on demand (results carry no screen text)          | script | `vibest run claude` in a herdr session: peek prints its screen (Claude's input box), at most N lines with `--lines`; an unknown id fails with `NoSuchSession`; skipped without herdr or claude                                                                                                                                             |
| I9  | Claude starts with no `--settings`; the plugin's `tool.call` guard holds its deny rules                     | script | a real `vibest run claude` session is refused Read of a project's instructions.md, `find` of its memory, `grep` of the project and `herdr --help`, each with the guard's reason in Claude's transcript, and no refused file's text reaches Claude; skipped without herdr or claude                                                         |

## Guard (harness adapters)

`vibest integration guard --harness <h>` as a harness plugin runs it: the tool call on stdin, the agent's environment.

| ID  | Capability                                                                                       | Method  | Pass when                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| R1  | an agent (session or coordinator) driving herdr itself (`herdr pane list`) is denied             | script  | deny in that harness's format (Claude `hookSpecificOutput`, Cursor `permission`) |
| R2  | a session reading the Project store's `docs/` or `memory/` directly is denied                    | script  | deny, with the `vibest project` hint                                             |
| R3  | ordinary work (`git status`, `git log`) is allowed for both roles; the coordinator edits no file | script  | allow / no output; `Write` denied for the coordinator                            |
| R4  | without a vibest agent the guard answers nothing and fails                                       | script  | non-zero exit, no decision (the plugin only asks for a vibest agent)             |
| R5  | input vibest cannot read                                                                         | script  | non-zero exit, which the plugin turns into a refusal                             |
| R6  | Pi: the same rules inside the Pi extension                                                       | runtime |                                                                                  |
| R7  | Claude: the plugin's `tool.call` and `turn.complete` reach vibest in a running Claude            | runtime |                                                                                  |

## Sessions, delivery and the main Agent (runtime)

Held until the Agent runtime is decided. Steps are in [e2e-user-stories.md](e2e-user-stories.md).

| ID  | Capability                                                                                                        | Method                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| S1  | `run` in a new worktree; `--name`, `--model`, `--provider`, `--env`, `--peer`, `--session`                        | runtime                                                         |
| S2  | `send` while busy queues, delivered once idle, merged                                                             | runtime                                                         |
| S3  | `report` reaches the coordinator; same-sender messages merge                                                      | runtime                                                         |
| S4  | `interrupt`; next `send` works                                                                                    | runtime                                                         |
| S5  | `result`, `status`, `ls`, `ls --all`                                                                              | runtime                                                         |
| S6  | `archive` clean / dirty / unpushed / `--keep-worktree`; process proof                                             | runtime                                                         |
| S7  | `run --archive-on-completion`                                                                                     | runtime                                                         |
| S8  | self-heal: daemon killed mid-turn; pane closed mid-turn; bad model → `LaunchFailed`                               | runtime                                                         |
| S9  | limits: `VIBEST_MAX_SESSIONS`                                                                                     | runtime                                                         |
| S10 | `vibest` main Agent: parent workspace, resume, `--new`, rules file, move to another terminal (y)                  | move: `tools/e2e` S10, S10-pi; the rest: runtime                |
| S11 | Claude coordinator inbox over HTTP: poll, lease, ack by row id; turn-end, prompt, guard hooks                     | inbox: `tools/e2e` S11                                          |
| S12 | Pi coordinator: inbox push, Pi TUI tool groups render                                                             | inbox push: `tools/e2e` S12; tool groups: runtime (agent)       |
| S13 | herdr status push: a status change reaches vibestd without the poll                                               | runtime                                                         |
| S14 | several repositories: separate Projects, one Project per repository wherever you stand in it, runs in two at once | agent (story S13 in [e2e-user-stories.md](e2e-user-stories.md)) |
| S15 | Claude coordinator over HTTP: two sessions, mid-turn, lease after the poller left, curl, daemon restart           | inbox: `tools/e2e` S15                                          |
| S18 | a subagent whose first turn outlasts herdr's agent.start window keeps its terminal (no false exit)                | inbox: `tools/e2e` S18                                          |
