# End-to-end test plan

What `pnpm test` covers today: every module against a fake herdr and fake harnesses. What it does not cover: a real
herdr session, a real CLI agent, real model output, real Claude / Pi / Cursor hook payloads. This plan covers
those, for every omac feature vibest carries.

## 1. Isolation

vibest writes nothing into the user's `~/.vibest`, harness config (`~/.claude`, `~/.pi`, `~/.cursor`), herdr sessions or
herdr-core. Every check gets its own World: a `0700` temp root with its own `VIBEST_HOME`, its own herdr sessions and,
where a check needs one, its own herdr-core. The harnesses run as the user runs them, on the user's environment and a
copy of the user's settings; only the model is fake.

| Thing         | E2E value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment   | the user's login environment, captured once per run with `$SHELL -l -i -c 'unset HISTFILE; env -0'` from an empty environment with `HISTFILE=/dev/null` (nothing reaches the user's shell history), never the runner's own. Dropped: shell-session state, runner variables (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `VIBEST_*`, `HERDR_*`, `HC_*`, `PI_PACKAGE_DIR`) and real-model access (`ANTHROPIC_*`, `OPENAI_*`, `*_API_KEY`, `*_BASE_URL`, `*_MODEL`, …). `NO_PROXY` and `no_proxy` get `127.0.0.1,localhost`                                                                                                                      |
| `HOME`        | the user's own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PATH`        | the login `PATH` with the build's (or the install's) `bin` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Pane shell    | the user's `$SHELL` with its rc files, read through a `ZDOTDIR` in the world that sources the user's zsh files and then points `HISTFILE` into the world (`HISTFILE` for bash too), so commands typed into panes never reach the user's shell history. After each user rc file the world's zsh puts the build's bin first on `PATH` again, so a bare `vibest` in a pane is this build. The Pi and Cursor plugins still reach vibest through `VIBEST_COMMAND`, and the Claude plugin talks to vibestd over HTTP (`$.http.fetch`). I11 and the terminal-status checks set an empty `ZDOTDIR`: their subject is an older `vibest` first on `PATH` |
| git           | the user's `~/.gitconfig`, read by git                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `VIBEST_HOME` | `<world>/vibest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Claude config | a shadow `CLAUDE_CONFIG_DIR` written from the user's `settings.json` keys `permissions`, `env` (without model, provider, base-URL, key or token variables, so the fake model's `ANTHROPIC_BASE_URL` wins), `language`, `worktree`, `autoMode`, `attribution`, `cleanupPeriodDays` and `.claude.json`'s onboarding and auto-mode keys, plus the fake key's approval. Not copied: hooks, `statusLine` and plugins (they reach the user's herdr, Rex and other orchestrators), the model choice, credentials. Auto mode is off: a fake model cannot answer its classifier's side requests (P8, S15 and U4 fail with it on)                        |
| Pi config     | a shadow `PI_CODING_AGENT_DIR` per agent: the user's `settings.json` keys `defaultThinkingLevel`, `defaultTools`, `steeringMode`, `doubleEscapeAction`, `codemode`, `tuiMode`, `theme`, `trust.json` copied, and a `models.json` naming only the fake providers. Not copied: `packages`, `auth.json`. vibestd's own Pi dir stays empty, as on a fresh install                                                                                                                                                                                                                                                                                  |
| Cursor config | a shadow `CURSOR_CONFIG_DIR` with the user's `cli-config.json` keys `version`, `approvalMode`, `sandbox`, `permissions` and `network`; never the model fields or `authInfo`. The gate runs no Cursor model execution                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Profiles      | `user` (the shadows above, the default) and `first-run` (today's defaults, no user keys). T1-pi runs in a temp `HOME` and uses `first-run`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| User files    | the files and keys the shadows read are hashed (content) before and after the run; a change fails the run. Evidence holds only these hashes, never their content                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| herdr         | sessions named `<world>[-…]` under the real `~/.config/herdr/sessions`, stopped and deleted when the check ends; a session left over fails the check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| herdr-core    | the hc and status checks start their own server (`HC_SOCKET`, `XDG_*` in the World)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Repository    | a scratch git repository with a local bare `origin`, so pushed / unpushed / dirty states are real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Releases      | `npm_config_registry` and `VIBEST_DOWNLOAD_URL` point at a local stand-in that names this checkout's version as the latest, so `vibest update` and the update notice never reach npm or GitHub and never install into the user's global npm                                                                                                                                                                                                                                                                                                                                                                                                    |
| Secrets       | values of secret-looking login variables and `VIBEST_E2E_ENV` values, and the user's model, provider and account values (Claude `model`, Pi `defaultProvider`/`defaultModel`, Cursor model fields and account ids), are shown as `<redacted>` in output and evidence; the run fails if evidence still holds one                                                                                                                                                                                                                                                                                                                                |

A test that starts the built vibestd itself (`test/plugin-binary.test.ts`) asks it over its socket, never through the
`vibest` CLI: the CLI starts a vibestd of its own when a Ping is slow and would leave a second, untracked one behind. It
gives vibestd a `PATH` of the system directories only, so vibestd does not poll the harnesses the user installed.

Every process a test or a check starts that could outlive it is recorded in the run's reap file
(`<tmpdir>/vibest-reap-<run pid>` or `vibest-reap-e2e-<run pid>`, `tools/reap.ts`) with its command and start time:
herdr servers, vibestd daemons, herdr-core cores and, under `pnpm test`, every Bun process a test starts (vitest's setup
puts `--preload=tools/reap-preload.ts` into `BUN_OPTIONS`; `bun run` refuses `--preload <path>` with a space, so a
vibestd started from source records itself before it runs). A core's row names its `hc hold` children, which keep its
terminals and outlive a core ended by a signal: the run's detached watcher records each of them as a row of its own
every half second while the core is still the recorded one. The watcher stops everything recorded when the run exits;
when it dies with the run (a killed agent session, a crash), the next `pnpm test` or `pnpm e2e` stops what every reap
file of an ended run still names and deletes the file. A process is signalled only by its own pid, never its group, and
only while it still has the recorded command and start time, checked again before each signal, so the user's own
vibestd, herdr and herdr-core are never touched.

## 2. Layers

**L0, already automated, no keys.** `pnpm test`;
`pnpm verify` runs build, typecheck and test, installs vibest as a user does (install.sh from a release archive, and npm
from the packed `@vibest/cli`, both while the unit tests run), then runs the gate on the curl install and, at the same
time, a smoke set (I1, I2, U1, U9, U10, H1) on the npm install; the npm install gets the full gate when its file layout
differs from the last one that passed it. A skip fails the run (tools/verify/README.md).

**L1, real herdr, no model.** Every command whose effect does not need a model execution.

| Feature       | Check                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon        | `vibest status` auto-start, `daemon restart`, the lock against a second daemon, `update` replacement with agents working (they keep running)        |
| Protocol      | an old protocol header is refused; caller roles (`VIBEST_AGENT`, `VIBEST_SESSION_ID`) are checked                                                   |
| Project store | `project info` and `search`; agents write and read the project folder with file tools, another project refused                                      |
| Plugins       | `plugins` lists a routing plugin; edit it on disk and see the reload; a refusing plugin blocks `run`                                                |
| Integrations  | each harness loads vibest's plugin from the built `harnesses/` (`pi -e`, `--plugin-dir`) beside the user's own; `doctor` without `VIBEST_HARNESSES` |
| Guard         | a real agent of each harness is refused herdr and another project's folder (I3, I9, I5)                                                             |
| Models        | `models`, `harness list`, `harness models <each>`                                                                                                   |

**L2, real harness, fake model by default.** One matrix row per harness (Claude, Pi, Cursor); a real model only for the
login smoke (I5). Prompts are deterministic:
"create `out-<nonce>.txt` containing `<nonce>`, then reply `DONE-<nonce>`".

| #   | Scenario                                                                          | Pass when                                                                                             |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `run` in a new worktree                                                           | pane exists, row `working` → `idle`, file in the worktree, `result` holds `DONE-<nonce>` as its reply |
| 2   | `send` a follow-up                                                                | delivered once (confirm-after-send), execution `completed`                                            |
| 3   | `report` from the worker                                                          | the entry session inbox gets it; same-sender messages merge                                           |
| 4   | `interrupt` mid-execution                                                         | execution `interrupted`, pane alive, next `send` works                                                |
| 5   | `--peer`, `--in-parent`, `--name`, `--model`, `--provider`, `--headless`, `--env` | each flag visible in the row and the pane                                                             |
| 6   | `archive` clean                                                                   | pane closed with PID proof, worktree removed, branch kept                                             |
| 7   | `archive` dirty / unpushed / `--keep-worktree`                                    | worktree kept, `reasons` names why                                                                    |
| 8   | `run --archive-on-idle`                                                           | archived right after the completed result reaches the entry session                                   |
| 9   | Self-heal                                                                         | kill the daemon mid-execution, restart: execution ends `lost` or resumes; no blind replay             |
| 10  | Startup failure                                                                   | bad model: a failed result with the error, no screen text; `vibest peek <id>` shows the pane          |
| 11  | Limits                                                                            | `VIBEST_MAX_SESSIONS=1`: the second `run` gets `LimitReached`                                         |
| 12  | Entry session                                                                     | `vibest` in the parent workspace, resume after its pane closes, system prompt file written            |

The pattern-level stories that combine these rows are in [e2e-user-stories.md](e2e-user-stories.md).

Claude only: the inbox bridge (`inbox attach/pull/ack/release`) delivers to a live Claude entry session without paste,
and `integration stop` ends cleanly. Pi only: the entry session TUI (tool groups, user-message padding) renders in the pane.

## 3. Runner

`tools/e2e` (Bun, private package): `pnpm e2e [area | id …] [--tier gate|slow|agent|all] [--jobs N] [--no-cache]
[--strict]`. Each check runs in a World of its own, so a check passes alone or not at all.

- **Pool.** Checks run in parallel in a pool shared by every worktree and every `pnpm e2e` on the machine: its slots are
  lock files under `<git-common-dir>/vibest-e2e/slots`, CPU count − 2 of them, and a check starts only while the one-minute
  load average is below the CPU count (one always runs when no slot is busy). `--jobs N` runs ungated: N checks at a
  time, with no load gate, ignoring the machine cap (it never waits for slots other runs hold). Checks start longest
  first, by the duration each last took (`vibest-e2e/timings.json`).
- **Flaky under load.** A failed check is run again alone. If it then passes it is reported `flaky-under-load`, which
  still fails the run.
- **Tiers.** `gate` (the default), `slow` (S18-slow, herdr's full 120 s window) and `agent` (I5: a real model; an agent
  runs it and attaches the evidence). An id named on the command line runs whatever its tier. A check that merges
  others names them (`covers`), and naming a covered id runs it: D1 covers D2–D4, H1 covers H2 and H3, I7 covers I4, S15
  covers S11. Naming T1 runs T1-claude and T1-pi.
- **Result cache.** A check that passed is not run again while its key is unchanged; it prints `CACHED`. The key hashes
  the vibest binary that runs (for npm and curl the installed launcher and the compiled binary it starts), the harness
  plugins tree but for the files Claude writes into it when it loads the plugin (`claude/tsconfig.json`,
  `claude/.claude-plugin/types/`), the runner's own source (all of `tools/e2e/src` but the checks), the check's area file
  and every file it imports by a relative path, recursively, the herdr, hc, claude, pi, cursor-agent, bun and node version numbers, the
  install method, the hashes of the user settings the shadows read, and the login `PATH`. Passes are kept under
  `<git-common-dir>/vibest-e2e/cache`, shared by every worktree. Agent-tier checks are never cached; `--no-cache` runs
  everything; `pnpm verify --no-cache` passes it to both legs and runs the whole gate on both installs, the run before a
  release. Turborepo's `e2e` task (`turbo run e2e`) skips the whole suite when neither the build nor `tools/e2e`
  changed, but it cannot see tool versions or the user's settings, so `pnpm verify` runs the runner and its cache.
- **Invariants.** After each check: no terminal outside its herdr sessions, no herdr session left. After the run: the
  user files the shadows read are unchanged, no line of the user's shell history files (`~/.zsh_history`, `~/.bash_history`,
  fish's) names one of this run's worlds (the user's own terminals and other runs keep writing there, so the file
  itself may change), and no evidence file holds a user model, provider or account value.

The run writes evidence to `tools/e2e/evidence/<run>/`: per check the commands, exit codes and output (`<id>.json`,
`<id>.alone.json` for a rerun), files a check saves, and `report.json` with every check's tier, outcome, start time and
duration, the wall time, the user files' hashes and the invariants. It signals and closes only the PIDs and panes it
recorded. A skipped check is reported as skipped, never as passed. A failed check keeps its World for inspection; a
passing one removes it. A herdr server whose socket is inside the world is stopped before that remove, including one
whose config directory is in the world rather than ~/.config/herdr/sessions. The next run removes a kept world older
than a day, and that world's herdr sessions with it. The world's own vibestd is stopped first, only when its pid file
names a vibest daemon whose socket is inside that world. A herdr session that is still running keeps its world.

Checks that run an execution use a fake model (`tools/e2e/src/fake-model.ts`): a local Anthropic Messages server for Claude
(the shadow `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` and the fake `ANTHROPIC_API_KEY` passed as vibest's own `--env`)
and OpenAI-compatible servers for Pi (the shadow `PI_CODING_AGENT_DIR`, whose `models.json` names them). The fake answers
from the request, so what the agent asks and does is scripted, and an execution can be held open until the check releases it.
The gate runs no real model; I5, the Cursor login smoke, is in tier `agent`. `VIBEST_E2E_ENV` (`KEY=VALUE` pairs, one
per line) names more values the evidence masks.

### The world

- `VIBEST_E2E_METHOD` (`npm` or `curl`) and `VIBEST_E2E_INSTALL`, set by `pnpm verify`, point the checks at an installed
  vibest; unset, they drive this checkout's build. The world sets no `VIBEST_HARNESSES`: npm's launcher sets it as for
  a user, and the build and the curl install find their plugins beside the binary.
- The world's environment is the login environment of §1, so the model options reach an agent only as vibest's own
  flags. It has no `PI_PACKAGE_DIR`: a Pi install directory the parent exported may be gone when a child starts, and Pi
  then reports version 0.0.0 and refuses extensions that want a newer Pi.
- On macOS the temp root is under `/tmp`: `vibest.sock` lives in `VIBEST_HOME`, and a Unix socket path is at most 104
  bytes there. vibest.db stores resolved paths, `/private/tmp`.
- `vibest run` and a bare `vibest` get `--session <run>` unless they name one: vibest's default session `vibest` is the
  user's own. A check's own sessions are named `<run>-…`.
- `World.tty` types the answers on a pseudo-terminal (Python `pty`); its output has CR LF line ends.
- Integration checks start their agents with `vibest run`, so vibestd knows each session as it would for a user.

### Real panes

What the checks that drive real herdr panes rely on:

- A pane gets the environment of its herdr server, which gets vibestd's. A check that needs something in its panes
  (`PI_CODING_AGENT_DIR`, or `CLAUDE_CONFIG_DIR` unset for the user's Claude login) starts vibestd and a herdr session
  of its own, and drops only that session at the end.
- Claude asks whether to trust a new folder and loads hooks only once it is trusted. For an entry session the check answers
  as the person does (down to Yes, then enter, `drivers/claude.ts`); vibest answers it for subagents.
- A Claude agent on a fake model gets `disableAutoMode` in its shadow settings: with auto mode on, the fake model cannot
  answer the auto-mode classifier's side requests.
- An enter typed right behind text in Claude's input box is sometimes swallowed; a check waiting for that line presses
  enter again.
- Claude refuses a standalone `sleep`: to keep an entry session busy, the check has its execution wait in a Bash call for a file
  the check creates.
- herdr drops a started agent's name when it is not marked ready within `agent.start`'s 120 s, and refuses
  `agent.prompt` until the agent is ready; it marks an agent ready only once the agent is read (S18, S19). S18 proves in
  the gate that `agent.start` has resolved (the terminal is recorded) while the first execution is still held; S18-slow
  waits the window out.
- With herdr's own Pi hook installed (`herdr integration install pi`), herdr reads Pi's state from the hook alone, and an
  idle Pi sends it nothing more (S19).
- Pi can open more than one model stream for one execution: a check that holds the model releases every stream held at
  that moment before the next execution starts.
- A fake usage limit is an error inside the stream: Pi reports its message as the execution's error, and retries a failed
  request, so every retry fails too (U5, U8).
- The user-file invariant hashes only the keys the shadows read: the user's own Claude and Pi sessions rewrite other
  keys of the same files while a run goes on, and cursor-agent rewrites `~/.cursor/cli-config.json`.
- cursor-agent's hook shell rebuilds `PATH`, so I5 names its recording `vibest` wrapper through `VIBEST_COMMAND`, which
  is how an agent vibest starts names its own binary.
- I9's Claude has no Glob or Grep tool and finds and searches with Bash (guard.test covers those tools). Its session
  rules say not to run herdr, and the model sometimes keeps to them: the check asks once more, for that call alone.
- Pi renames its process to `pi`, and herdr may then show no argv for it: S10-pi proves the resume by B showing A's
  conversation, and finds a harness by the program's own name, not a shell or `vibest` naming it in its arguments.
- S10 runs one execution first: vibest resumes only a conversation the harness wrote. It prompts through herdr's
  `agent.prompt`, as vibest does; an enter typed into Pi's editor only adds a line. herdr marks a finished execution nobody
  looked at `done`. A keeps only its shell once what the harness's extensions started (Pi's update checks) has ended.

### Kill windows

S24, S28 and S29 kill vibestd inside a window. S24: while the row is `delivering`, from its claim until the session
is seen to start the execution. S28: after `vibest run` answers, which it does once the row is stored; the start then makes
the worktree and opens the terminal. S29: at the first look for the harness's ready report. A try that misses its window (the task linked, or the session archived, before
the kill) is not the case, so S24, S28, S29 and S30 try again, up to five times. S30 kills vibestd once `vibest archive`
has stored its mark, before it closes anything. S27's process outside the pane works in the worktree: closing the pane does not
end it.

## 4. Cost and time

The gate's executions run on fake models and cost nothing; I5's Cursor execution, in tier `agent`, is the one real-model execution.
Measured on a 10-core Mac shared with other agents' E2E runs (2026-11-07):

| Run                                        | Wall time                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `pnpm e2e`, 52 gate checks, nothing cached | 164–285 s at a load average of 7–12; 450–660 s when the load stays above the CPU count |
| `pnpm e2e`, nothing changed                | about 1 s (every check a cache hit)                                                    |
| `pnpm test`, nothing cached / cached       | 41 s / 2 s                                                                             |
| `pnpm verify`, nothing cached              | 570–705 s at a load average of 8–14 (both legs' gates run at once)                     |
| `pnpm verify`, nothing changed             | 6 s                                                                                    |

The load gate admits a new check only while the load average is below the CPU count, so on a machine other runs keep
above it the checks run nearly one at a time; that is the price of not flaking under load.

`bun tools/bench/src/ls.ts` measures `vibest ls` at 200 and 1000 sessions: the median and p95 of 20 runs, and vibestd's
CPU seconds over 60 idle seconds. It seeds the sessions in a temp home under a runtime kind that is not registered, so no
runtime is called. `vibest ls` prints JSON already; it has no `--json` flag.

In `pnpm test`, `cli.test.ts` starts a fresh Bun process for each `vibest` (about 0.3 s, several seconds on a loaded
machine), up to twenty per test, so its tests run one at a time: run together they share the CPU, and on a two-core CI
runner they cost twice as much (23 s for the file against 12 s in execution).

The unit fakes (`packages/cli/test/fakes.ts`): `until` polls up to 2000 times 10 ms, about 20 s, under the 30 s test
timeout. `withStdin` feeds a command from a file, not a pipe, so a command that exits without reading raises no EPIPE.
Each node layer of a process chain gets a `-` filler argument, which Bun running as node drops. The test layer gives
every test its own `TMPDIR`. Plugin-loading tests make their `VIBEST_HOME` under `packages/cli/test/.tmp`, inside
the package, so plugin files resolve `@vibest/plugin` and `effect`; the reload tests load plugins with Node's `require`
after evicting its cache, bypassing Vitest's module cache.

`pnpm test` runs Vitest under Bun, so `#platform` resolves through the `bun` condition (`vitest.config.ts`) to the Bun
layers. Concurrent tests of one file share a worker, and Vitest's 5 s default is too tight once several git or Bun tests
overlap, so the timeout is 30 s. `vitest.setup.ts` drops `PI_PACKAGE_DIR`: a Pi install directory the parent exported
may be gone when a child starts, and a test that starts `pi` would then read version 0.0.0 and exit before herdr sees
it; the install beside `pi` is the one to use.

## 5. Capabilities and their proof

The capabilities are specified in [docs/features](../features/), one file per area, in plain language: each has an id
and says when it counts as working. Those files are for the agent that leads a verification (the `verify-features`
skill, `.agents/skills/verify-features/SKILL.md`); no script reads them. Each E2E check carries the id of the capability
it is about in its name (`S10-start` and `S10-pi` are about `S10`) and lists in `covers` the other ids it also proves;
`bun tools/e2e/src/main.ts --list` prints every check's id, tier and covers as JSON. I6 is the runner's own check after
every run.

Every check that runs an execution runs it on a fake model server (`tools/e2e/src/fake-model.ts`: Anthropic Messages for
Claude, OpenAI-compatible for Pi) with shadow harness config, so its prompts and answers are scripted; no gate check runs
a real model. No script can prove these, so the verifying agent does them by hand:

- D9 needs a newer release published to npm.
- I5 and I10 need the user's own Cursor login (`pnpm e2e --tier agent I5` runs I5's steps on it). Cursor cannot run on a
  fake model: `cursor-agent --endpoint` speaks Cursor's own backend protocol, not a model API a fake can answer, and a
  real model cannot be held between hook events.
- S39 depends on timing: the Claude plugin polls every second and the Pi stream claims each message as it is queued, so
  whether two reports share one delivery depends on when they are queued.
- S13 has no assertion: S25 only records how long a status change takes to reach vibestd, so the verifying
  agent checks by hand that the change arrives without waiting for the next poll.

Notes on particular checks:

- U3 has no release path that reaches it while releases share a schema; `rpc.test.ts` (Daemon.Handoff with a failing
  import check) proves it in `pnpm test`.
- U2, U4, U6 and U11 start from an old install that is a copy of this build whose version is patched to an older one,
  until a published previous release shares this build's database schema; then they move to that release, downloaded
  once into an E2E cache. U11's old install also has its protocol patched one lower, since only an older binary that
  hands the restart step on can pass it.
- T1 uses its own HOME, HC_SESSION, HC_SOCKET and XDG directories; it never contacts the user's herdr-core or changes
  harness configuration outside that temporary root. Its fixture runtime plugin (`fixtures/status-runtime.ts`) also
  proves G7. Entry session status coverage is the follow-up in
  [runtime-port.md](../design/runtime-port.md#terminal-status-ownership).
- On macOS, Cursor model discovery and subscription probes need `Library/Keychains/login.keychain-db` as a regular file
  under HOME. H4 puts a sentinel Cursor CLI on PATH and fails if it runs; when a World changes HOME it removes the
  inherited SSH session variables, which H4 checks in a spawned process.
- The guard rules themselves are `guard.test.ts`; without a vibest agent, or when vibestd cannot check the call,
  `vibest integration guard` fails with no answer (`cli.test.ts`). Cursor's deny and allow answers through vibestd are
  `guard.test.ts`; a stop refused with each unsettled daemon operation or delivery named (D7, and D8, whose handoff
  drains the same way) is `stop.test.ts`; which installer U1 runs is `update.test.ts`; an entry session restarting through
  `VIBEST_COMMAND` (I11) is `restart.test.ts`.
- The machines checks run two vibest homes on one host: A's vibestd dials B through a fake `ssh` first on its PATH,
  which runs the line with B's environment; agents on both sides run in isolated hc cores on fake models.
