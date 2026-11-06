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
| Project store | `project info` and `search`; agents write and read the project folder with file tools, another project refused                                      |
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
| 12  | Coordinator                                                                       | `vibest` in the parent workspace, resume after its pane closes, system prompt file written                                |

The pattern-level stories that combine these rows are in [e2e-user-stories.md](e2e-user-stories.md).

Claude only: the inbox bridge (`inbox attach/pull/ack/release`) delivers to a live Claude coordinator without paste,
and `integration stop` ends cleanly. Pi only: the coordinator TUI (tool groups, user-message padding) renders in the pane.

## 3. Runner

`tools/e2e` (Bun, private package): one scenario per file, run in sequence, each with a timeout. It writes evidence to
`tools/e2e/evidence/<run>/`: commands, exit codes, `ls --json`, `result`, pane text, and the database. It signals and
closes only the PIDs and panes it recorded. A skipped harness (no key) is reported as skipped, never as passed. A check
that leaves a pane outside the run's herdr sessions fails, whatever it proved. A run with a failure keeps its temp world
for inspection; a clean run removes it. U1 stops vibestd first: a running one would be offered for replacement, which
asks on a terminal.

Real-model checks give the agents they have vibest start a model through vibest's own options (`--provider`,
`--model`), chosen in one place (`tools/e2e/src/world.ts` `agentModel`): `VIBEST_E2E_PROVIDER` and `VIBEST_E2E_MODEL`
when set, else Claude Haiku. The checks that start a harness directly (I3–I5) keep their own flags. vibest's Claude
adapter accepts no provider other than `anthropic`, so a provider for the Claude checks is refused by vibest itself.
`VIBEST_E2E_ENV` adds environment for those agents: `KEY=VALUE` pairs, one per line, each passed as vibest's own
`--env`. With `--model` it runs a Claude agent on another Anthropic-compatible endpoint, for example
`VIBEST_E2E_ENV=$'ANTHROPIC_BASE_URL=<endpoint>\nANTHROPIC_AUTH_TOKEN=<token>' VIBEST_E2E_MODEL=<model>`. Unset, nothing
changes. Its values are never printed: console output, failure details and evidence show `<redacted>` instead.

### The world

- `VIBEST_E2E_METHOD` (`npm` or `curl`) and `VIBEST_E2E_INSTALL`, set by `pnpm verify`, point the checks at an installed
  vibest; unset, they drive this checkout's build. The world sets no `VIBEST_HARNESSES`: npm's launcher sets it as for
  a user, and the build and the curl install find their plugins beside the binary.
- The world's environment drops every inherited `VIBEST_*` and `HERDR_*` variable, so the model options reach an agent
  only as vibest's own flags. It drops `PI_PACKAGE_DIR` too: a Pi install directory the parent exported may be gone when
  a child starts, and Pi then reports version 0.0.0 and refuses extensions that want a newer Pi.
- On macOS the temp root is under `/tmp`: `vibest.sock` lives in `VIBEST_HOME`, and a Unix socket path is at most 104
  bytes there. vibest.db stores resolved paths, `/private/tmp`.
- `vibest run` and a bare `vibest` get `--session <run>` unless they name one: vibest's default session `vibest` is the
  user's own. A check's own sessions are named `<run>-…`.
- `World.tty` types the answers on a pseudo-terminal (Python `pty`); its output has CR LF line ends.
- Integration checks seed sessions straight into vibest.db (`knownSessions`), in a project with no directory, so no
  `vibest` finds them and no harness starts: vibestd records turn events, and answers the Claude plugin, only for a
  session it knows.

### Real panes

What the checks that drive real herdr panes rely on:

- A pane gets the environment of its herdr server, which gets vibestd's. A check that needs something in its panes
  (`PI_CODING_AGENT_DIR`, or `CLAUDE_CONFIG_DIR` unset for the user's Claude login) starts vibestd and a herdr session
  of its own, and drops only that session at the end. An empty `ZDOTDIR` keeps the pane shell from putting another
  vibest first on `PATH`.
- Claude asks whether to trust a new folder and loads hooks only once it is trusted. For a main agent the check answers
  as the person does (down to Yes, then enter); vibest answers it for subagents.
- An enter typed right behind text in Claude's input box is sometimes swallowed; a check waiting for that line presses
  enter again.
- Claude refuses a standalone `sleep`: to keep a main agent busy, the check has its turn wait in a Bash call for a file
  the check creates.
- herdr drops a started agent's name when it is not marked ready within `agent.start`'s 120 s, and refuses
  `agent.prompt` until the agent is ready; it marks an agent ready only once the agent is read (S18, S19).
- With herdr's own Pi hook installed (`herdr integration install pi`), herdr reads Pi's state from the hook alone, and an
  idle Pi sends it nothing more (S19).
- Pi can open more than one model stream for one turn: S26 releases every stream held at that moment before the next
  turn starts.
- A fake usage limit is an error inside the stream: Pi reports its message as the turn's error, and retries a failed
  request, so every retry fails too (U5, U8).
- I3–I5 stop the harness once `vibest result` shows its result (`until-file.py`). I6 leaves out
  `~/.cursor/cli-config.json`: vibest never touches it, and cursor-agent rewrites it while it runs.
- cursor-agent's hook shell rebuilds `PATH`, so I5 names its recording `vibest` wrapper through `VIBEST_COMMAND`, which
  is how an agent vibest starts names its own binary.
- I9's Claude has no Glob or Grep tool and finds and searches with Bash (guard.test covers those tools). Its session
  rules say not to run herdr, and the model sometimes keeps to them: the check asks once more, for that call alone.
- Pi renames its process to `pi`, and herdr may then show no argv for it: S10-pi proves the resume by B showing A's
  conversation, and finds a harness by the program's own name, not a shell or `vibest` naming it in its arguments.
- S10 runs one turn first: vibest resumes only a conversation the harness wrote. It prompts through herdr's
  `agent.prompt`, as vibest does; an enter typed into Pi's editor only adds a line. herdr marks a finished turn nobody
  looked at `done`. A keeps only its shell once what the harness's extensions started (Pi's update checks) has ended.
- S10-pi needs `VIBEST_E2E_MODEL`: Pi refuses `--provider` without `--model`, and Pi's own default is whatever the user
  last picked.

### Kill windows

S24, S28, S29 and S31 kill vibestd inside a window. S24: while the row is `delivering`, from its claim until the session
is seen to start the turn. S28: after `vibest run` answers, which it does once the row is stored; the start then makes
the worktree and opens the terminal. S29: at the first look for the harness's ready report. S31: between the result's
delivery and the archive's mark. A try that misses its window (the task linked, or the session archived, before the
kill) is not the case, so S29 and S31 try a new subagent, up to five times. S30 writes only the mark `vibest archive`
stores first, before it closes anything. S27's process outside the pane works in the worktree: closing the pane does not
end it.

## 4. Cost and time

About 12 short turns per harness on the cheapest model: roughly 50 turns per full run, about 20–30 minutes.

`bun tools/bench/src/ls.ts` measures `vibest ls` at 200 and 1000 sessions: the median and p95 of 20 runs, and vibestd's
CPU seconds over 60 idle seconds. It seeds the sessions in a temp home under a runtime kind that is not registered, so no
runtime is called. `vibest ls` prints JSON already; it has no `--json` flag.

In `pnpm test`, `cli.test.ts` starts a fresh Bun process for each `vibest` (about 0.3 s, several seconds on a loaded
machine), up to twenty per test, so its tests run one at a time: run together they share the CPU, and on a two-core CI
runner they cost twice as much (23 s for the file against 12 s in turn).
