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
Checks that run a turn run it on a fake model server (`tools/e2e/src/fake-model.ts`: Anthropic Messages for Claude,
OpenAI-compatible for Pi) with temp harness config, so their prompts and answers are scripted. Only I5 runs a real model,
on the user's own Cursor login.

## Daemon and protocol

| ID  | Capability                                                                                                                                                | Method | Pass when                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `vibest status` without a daemon                                                                                                                          | script | prints client and "not running", starts nothing                                                                                                                     |
| D2  | `vibest daemon` starts vibestd in the background; a second `vibest daemon` exits 0 and starts no second one                                               | script | one PID in `$VIBEST_HOME`, both commands exit 0                                                                                                                     |
| D3  | lock: `vibest daemon --foreground` while one runs does not take over                                                                                      | script | says already running, exits 0, the first daemon untouched                                                                                                           |
| D4  | `vibest daemon restart` when idle replaces vibestd                                                                                                        | script | new PID, same socket answers                                                                                                                                        |
| D5  | protocol: a request without the `vibest-protocol` header, or with an old value, is refused                                                                | script | `ProtocolRejected`, daemon still answers                                                                                                                            |
| D6  | caller roles: `VIBEST_AGENT` / `VIBEST_SESSION_ID` that do not match a row are refused                                                                    | script | `InvalidCaller` / `Forbidden`                                                                                                                                       |
| D7  | `vibest daemon restart` while agents work replaces vibestd; agents keep running, queued messages are kept; unfinished daemon operations refuse it by name | script | S12, S15, S19: results and sends after a restart; U6: agents restarted in place; the refusal by name: `stop.test.ts`                                                |
| D8  | `vibest update` with work in flight: replacement waits or names blockers                                                                                  | script | U2, U4: the handoff with an agent mid-turn                                                                                                                          |
| U1  | `vibest update` reads the latest version where vibest was installed from: npm's registry or the GitHub release; a build installs nothing                  | script | a local registry and release name this version: npm and curl installs are up to date and install nothing; a build says so; which installer runs is `update.test.ts` |
| U2  | `vibest update` hands vibestd over and restarts an old Pi main agent mid-turn in its own terminal                                                         | script | same session, conversation and terminal; new harness pid; the turn gets `continue`; results still arrive (old install: see below the table)                         |
| U3  | a handoff the new vibest refuses before the takeover (a database it cannot open) leaves the old vibestd serving                                           | unit   | `rpc.test.ts` Daemon.Handoff with a failing import check: no release path reaches it while releases share a schema                                                  |
| U4  | a Claude main agent runs `vibest update --yes` itself; vibestd restarts it in its pane                                                                    | script | same session, conversation and terminal; the continue notice arrives; `vibest update` runs once (old install: see below the table)                                  |
| U5  | a usage-limit move ends only the limited harness and runs the next one in the same pane                                                                   | script | same pane and session; old pid gone; one round completes on the next login                                                                                          |
| U6  | `vibest daemon restart` onto another vibest offers the agents on an old integration and restarts them in place                                            | script | same pane and conversation; new harness pid; integration version updated (old install: see below the table)                                                         |
| U8  | a usage-limit move tries each login at most once per round, whatever its usage reading says                                                               | script | one failed result "no harness left"; no third start in the pane                                                                                                     |
| U9  | `vibest update` to a version that cannot open the database installs nothing; the way out its message names lets it through                                | script | old vibestd and install untouched; after the message's steps the update installs                                                                                    |
| U10 | `vibest daemon restart` onto a vibest that cannot open the database stops nothing and asks nothing                                                        | script | same vibestd pid answers; a restart once the database fits replaces it                                                                                              |
| D9  | `vibest update` from the registry                                                                                                                         | agent  | needs a published newer beta; the agent checks the prompt, the confirmation and the replaced daemon                                                                 |

U2, U4 and U6 start from an old install that is a copy of this build whose version is patched to an older one. No
published release can stand in yet: beta.16, the release before this version, has another database schema under the
same application id and user version, so this build's import check refuses its database and the handoff never starts;
beta.17 is this version, so nothing is outdated. Once beta.18 is published and beta.17 is the previous release, these
three checks move to the real previous release, downloaded once into an E2E cache and reused.

## Project store

| ID  | Capability                                                              | Method | Pass when                                            |
| --- | ----------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| P1  | `project info` in a repository                                          | script | the folder `projects/<id>` and its subfolder paths   |
| P2  | `project search` over `docs`, `memories`, `artifacts`                   | script | hits `kind/path:line: text`                          |
| P7  | a moved checkout: `vibest` asks `[Y/n]`, y moves it                     | script | same project id, new path, memories, worktree ok     |
| P8  | Pi main, Pi and Claude subagents use the folder with file tools (fakes) | script | each writes and reads `artifacts/`; other project no |

## Plugins

| ID  | Capability                                                                             | Method  | Pass when                                                 |
| --- | -------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- |
| G1  | `vibest plugins` lists a plugin from `$VIBEST_HOME/plugins` and one from `vibest.json` | script  | both listed with zero counters                            |
| G2  | editing a plugin file reloads it without a daemon restart                              | script  | `plugins` shows the new version; same daemon PID          |
| G3  | a plugin that throws at load is reported, others keep working                          | script  | error in `plugins`, the rest listed                       |
| G4  | a refusing `run` hook blocks `vibest run` with its reason, before any pane or worktree | script  | non-zero exit, reason printed, no worktree, no herdr pane |
| G5  | a routing plugin picks the harness for `run`                                           | runtime |                                                           |

## Terminal reports

| ID  | Capability                                                        | Method | Pass when                                                                                                           |
| --- | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| T1  | Native Claude/Pi OSC 7501 and shipped Cursor hooks in isolated HC | script | Native working/blocked/resume/done/abort, unchanged results, Cursor working/idle only; raw evidence, no visible OSC |

T1 uses its own HOME, HC_SESSION, HC_SOCKET and XDG state/config/runtime directories; it never contacts the
user's herdr-core or changes harness configuration outside that temporary root. Coordinator coverage awaits
herdr-core caller detection; the exact follow-up check is in [runtime-port.md](../design/runtime-port.md#terminal-status-ownership).

T1's Cursor half writes its Cursor session straight into the database and drives the shipped hook script with a
fixture, because no real start reaches what it checks. A real cursor-agent needs the user's own login and a paid
model, while T1 runs under its own HOME, and a real model can be neither held between hook events nor made to send
the malformed and ignored events the check feeds the hook. A stand-in cursor-agent started by `vibest run cursor`
gets its session from vibestd, but vibestd then waits for herdr-core to report a status before it types the first
prompt, and herdr-core has none for Cursor until its first hook; the stand-in would have to invent that report, and
the typed prompt lands in the middle of the scripted hook sequence. I5 is the real Cursor start.

## Harnesses and models (harness adapters)

| ID  | Capability                                                                                                | Method | Pass when                                                           |
| --- | --------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| H1  | `harness list` (vibestd `Harnesses.List`): binary, startable, default model, per harness                  | script | one entry per harness (Claude, Pi, Cursor); a missing CLI says so   |
| H2  | `harness models <harness>` / `models`                                                                     | script | non-empty list for each installed harness; a missing one is skipped |
| H3  | `doctor`: grouped (coding agents, herdr, vibestd, plugins), a fix line under each problem, then a verdict | script | one agent line per harness; a herdr line per usable harness         |
| H4  | Cursor discovery and subscription probes under a temporary macOS HOME                                     | script | no Cursor starts with an empty Keychains directory; SSH is cleared  |

On macOS, Cursor model discovery and subscription probes require `Library/Keychains/login.keychain-db`
to be a regular file under HOME; an empty Keychains directory is refused. This also keeps T1's daemon
and harness-choice plugin from starting real Cursor behind its hook fixture. H4 puts a sentinel CLI on PATH
and fails if it runs. Direct Cursor commands in the E2E World check the login keychain file too.
When a World changes HOME (including T1), it removes the inherited SSH session indicators; H4 checks
this in a spawned process.

## Integrations (harness adapters)

vibest's plugin for each harness ships in `@vibest/cli` (`harnesses/<harness>`, `VIBEST_HARNESSES`) and is loaded into each
session vibest starts: Pi `-e`, Claude and Cursor `--plugin-dir`. Nothing is installed. I3 and I4 run on a fake model with temp
config; I5 uses the user's own Cursor login and config, read only; the user's real config files keep their modification
times (I6).

| ID  | Capability                                                                                                  | Method | Pass when                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | the plugins ship with vibest; `integration` is only the hooks' `guard` and `stop`                           | script | each harness's plugin files are in the built `harnesses/`; `integration install` does not exist                                                                                                                                                                                                                                                                                                                     |
| I2  | the binary alone finds its plugins beside it; no plugins, no harness                                        | script | without `VIBEST_HARNESSES`, `dist/vibest` finds `harnesses/`; a copy with none beside it makes `doctor` name the missing directory for each harness                                                                                                                                                                                                                                                                 |
| I3  | a real Pi runs vibest's extension from `pi -e`                                                              | script | on a fake model, the agent's `herdr pane list` is refused with the guard's reason and does not run; its reply is the session's `vibest result`; skipped without pi                                                                                                                                                                                                                                                  |
| I4  | a real Claude runs vibest's plugin from `--plugin-dir` beside plugins installed in its config               | script | on a fake model, with a plugin installed into its temp config: that plugin's `SessionStart` hook runs beside vibest's, and the reply is the session's `vibest result`; skipped without claude                                                                                                                                                                                                                       |
| I5  | a real cursor-agent runs vibest's plugin from `--plugin-dir` beside the project's own hooks                 | script | `vibest run cursor` on the user's login, asked to run `herdr pane list`: herdr does not run (the model either tries and the guard refuses, or keeps to its rules; which one is recorded); the turn completes and its `vibest result` carries the reply; the project's own hook ran; skipped without cursor-agent or its login; fails when cursor cannot start or harness-choice routes the start to another harness |
| I6  | the user's own harness config files do not change                                                           | script | real `~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/.pi/agent/settings.json` modification times unchanged (`~/.cursor/cli-config.json` is out: vibest never writes it and cursor-agent rewrites it itself)                                                                                                                                                                                                   |
| I7  | every Claude main-loop turn end is the plugin's turn.complete: answer, the person's Esc, `vibest interrupt` | script | `vibest run claude` on a fake model that holds its turns: an answer is a completed result; Esc in the pane is exactly one failed result with "interrupted: the turn was stopped in its terminal (Esc) before it ended"; after `vibest interrupt` the aborted turn.complete reaches vibest (vibestd logs the end), no result; skipped without herdr or claude                                                        |
| I9  | Claude starts with no `--settings`; the plugin's `tool.call` guard holds its deny rules                     | script | `vibest run claude` on a fake model that asks for `herdr --help`, a Read of another project's preferences.md, `find` of its memories and `grep` of it: each is refused with the guard's reason, no refused file's text reaches the model, a Read in its own project folder is allowed; its argv has `--plugin-dir` and no `--settings`; skipped without herdr or claude                                             |

## Guard (harness adapters)

The pre-tool guard as each harness plugin runs it, proven in a real agent of each harness: I3 (Pi), I9 (Claude), I5
(Cursor, when its real model tries). Without a vibest agent, or on input it cannot read, `vibest integration guard` fails with no answer
(`cli.test.ts`); the rules themselves are `guard.test.ts`.

| ID  | Capability                                                                            | Method | Pass when                              |
| --- | ------------------------------------------------------------------------------------- | ------ | -------------------------------------- |
| R6  | Pi: the same rules inside the Pi extension                                            | script | I3                                     |
| R7  | Claude: the plugin's `tool.call` and `turn.complete` reach vibest in a running Claude | script | I9 (`tool.call`), I7 (`turn.complete`) |

## Sessions, delivery and the main Agent (runtime)

Held until the Agent runtime is decided. Steps are in [e2e-user-stories.md](e2e-user-stories.md).

| ID  | Capability                                                                                                                                                                               | Method                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1  | `run` in a new worktree; `--name`, `--model`, `--provider`, `--env`, `--peer`, `--session`                                                                                               | runtime                                                              |
| S2  | `send` while busy queues, delivered once idle, merged                                                                                                                                    | queued and delivered: `tools/e2e` S26; the merge: runtime            |
| S3  | `report` reaches the coordinator; same-sender messages merge                                                                                                                             | runtime                                                              |
| S4  | `interrupt`; next `send` works                                                                                                                                                           | interrupt: `tools/e2e` S19, I7; the next send: runtime               |
| S5  | `result`, `status`, `ls`, `ls --all`                                                                                                                                                     | runtime                                                              |
| S6  | `archive` clean / dirty / unpushed / `--keep-worktree`; process proof                                                                                                                    | runtime                                                              |
| S7  | `run --archive-on-completion`                                                                                                                                                            | exits: `tools/e2e` S31                                               |
| S8  | self-heal: daemon killed mid-turn; pane closed mid-turn; bad model → `LaunchFailed`                                                                                                      | daemon killed: `tools/e2e` S23; pane closed: S21; bad model: runtime |
| S9  | limits: `VIBEST_MAX_SESSIONS`                                                                                                                                                            | runtime                                                              |
| S10 | `vibest` main Agent: parent workspace, resume, `--new`, system prompt file, move to another terminal (y)                                                                                 | move: `tools/e2e` S10, S10-pi (fake models); the rest: runtime       |
| S11 | Claude coordinator inbox over HTTP: poll, lease, ack by row id; turn-end, prompt, guard hooks                                                                                            | inbox: `tools/e2e` S11                                               |
| S12 | Pi coordinator: inbox push, Pi TUI tool groups render                                                                                                                                    | inbox push: `tools/e2e` S12; tool groups: runtime (agent)            |
| S13 | herdr status push: a status change reaches vibestd without the poll                                                                                                                      | `tools/e2e` S25, S26 record how long it takes; no bound is asserted  |
| S14 | several repositories: separate Projects, one Project per repository wherever you stand in it, runs in two at once                                                                        | agent (story S13 in [e2e-user-stories.md](e2e-user-stories.md))      |
| S15 | Claude coordinator over HTTP: two sessions, mid-turn, lease after the poller left, curl, daemon restart                                                                                  | inbox: `tools/e2e` S15                                               |
| S18 | a subagent whose first turn outlasts herdr's agent.start window keeps its terminal (no false exit)                                                                                       | inbox: `tools/e2e` S18                                               |
| S19 | a Pi subagent under herdr's Pi hook gets its first prompt within seconds; restart and interrupt work                                                                                     | inbox: `tools/e2e` S19                                               |
| S20 | ids: `run` answers a UUID, herdr agent `s-<30 hex>`, `result <8>`, `peek <12>`, system prompt file; `peek` prints the screen, `--lines N` at most N lines, an unknown id `NoSuchSession` | inbox: `tools/e2e` S20                                               |
| S21 | pane killed mid-turn: the turn fails, the queued send fails with its notice; one result; the time is recorded                                                                            | exits: `tools/e2e` S21                                               |
| S22 | harness killed (kill -9), its pane kept: as S21                                                                                                                                          | exits: `tools/e2e` S22                                               |
| S23 | vibestd restarted mid-turn, or killed after the turn end: exactly one result, its turn.end has `report`                                                                                  | exits: `tools/e2e` S23                                               |
| S24 | vibestd killed mid-delivery: the row fails once with the may-or-may-not notice; a later send is delivered                                                                                | exits: `tools/e2e` S24                                               |
| S25 | herdr hands over to a new server: the reset reconcile runs; a later close is seen (the time is recorded); send works                                                                     | exits: `tools/e2e` S25                                               |
| S26 | latency of 10 send rounds and 10 pane closes: every send goes out, every close ends its process; the times are recorded                                                                  | inbox: `tools/e2e` S26                                               |
| S27 | archive with a process working in the worktree: worktree kept, the reason names it; the time is recorded                                                                                 | exits: `tools/e2e` S27                                               |
| S28 | vibestd killed before a spawn opened its terminal: `launch_failed`, one notice, worktree removed (or kept, named)                                                                        | exits: `tools/e2e` S28                                               |
| S29 | vibestd killed before the first task was handed over: the next vibestd types it once; one result                                                                                         | exits: `tools/e2e` S29                                               |
| S30 | archive cut off after its mark: the next vibestd closes its tab, ends it `archived`, keeps the worktree                                                                                  | exits: `tools/e2e` S30                                               |
| S31 | vibestd killed between a delivered result and `--archive-on-completion`: archived once, no notice                                                                                        | exits: `tools/e2e` S31                                               |
| S32 | Send repeated with one request id: the same answer, one row, one delivery, one result                                                                                                    | exits: `tools/e2e` S32                                               |
| S33 | herdr-core runtime: Pi main agent and subagents in hc, results and send, status, herdr-app labels and parent                                                                             | hc: `tools/e2e` S33                                                  |
| S34 | herdr-core runtime: `vibest --runtime hc` typed in the user's hc terminal starts the main agent in place                                                                                 | hc: `tools/e2e` S34                                                  |
| S36 | herdr-core runtime: an unwatched subagent turn end is `done` in Watch (session and project); `Session.Seen` writes `herdr.seen` and it is idle                                           | hc: `tools/e2e` S36                                                  |
