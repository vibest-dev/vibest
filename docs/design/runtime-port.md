# Runtime plugins and machines

The agent runtime is where Agents' terminals live: herdr, rex and tern today, other products later. vibest owns the
flow (who runs, where, what came back); a runtime owns terminals and how to reach a machine. The API is
[`packages/plugin/src/runtime.ts`](../../packages/plugin/src/runtime.ts); `packages/runtime-herdr` is a runtime plugin
built on it. This replaces the herdr-shaped `RuntimeClient` (architecture §10) and answers open
question 3 (§12, §17).

## 1. Principles

1. **Simple, clear, extensible.** One interface, `Runtime`: seven required members, the rest optional. The API
   ships with vibest and has no version of its own: additions are optional members; a breaking change ships in a
   vibest release and plugins update with it. Core checks whether an optional
   member exists, never which runtime it is. One error type with a `code`.
2. **Runtimes are plugins, several at once.** A runtime plugin registers a `Runtime` (`context.runtime.register`, beside
   `context.agent.hook`). It is a provider core calls, not a hook listener. herdr, rex and tern ship as builtin
   runtime plugins; a new product is a new plugin, never a core change.
3. **vibest saves machines, the runtime connects.** Core has no ssh, Tailscale or socket code. Connections are the
   plugin's: it opens, reuses and re-opens them per machine in its own scope.
4. **Connections go outward only.** vibestd calls runtimes; nothing on a machine calls back.
5. **The truth about a turn comes from vibest's harness integration**, not from the runtime.

## 2. Terms

| vibest                                                      | herdr            | rex                     | tern           |
| ----------------------------------------------------------- | ---------------- | ----------------------- | -------------- |
| runtime on a machine                                        | session (socket) | server (`/api/control`) | session daemon |
| Project's terminals kept together (the runtime decides how) | workspace        | session                 | session        |
| **Terminal** `{ machine, id }`                              | pane             | block                   | block          |

An Agent row stores `runtime { kind, address: Terminal }` (JSON, no DDL); equal terminals encode to equal JSON.

## 3. The interface

Required: `kind`, `status(machine)`, `events` (exited, state, reset: core reads a runtime only when one arrives, and
once at start and on a reset), and on terminals `open`, `send`, `read`, `process`, `close`. `open`'s input
beside the placement (`project`, `cwd`, `argv`, `env`, `label`) carries `near` (beside that terminal when possible),
`split` (a split beside `near` instead of a tab of its own, `vibest run --peer`) and `focus` (the user is waiting to
see it); each is the runtime's to honor as it can.

| Optional                     | herdr                                                                                                            | rex                            | tern                                     | Core's fallback when absent                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `state(terminal)`            | detected                                                                                                         | OSC 7501 the program wrote     | OSC 7501 (window side)                   | harness integration only                       |
| `session(terminal)`          | the agent record's conversation id                                                                               | —                              | —                                        | the harness's reports only                     |
| `events` (required)          | `events.subscribe`                                                                                               | `session.attach_all`           | `tern events`                            | none: required                                 |
| `exec(machine, argv, cwd)`   | —                                                                                                                | detached block, `child_exited` | `new tab --keep-open`, `wait`, `capture` | hidden terminal: `open`, wait for exit, `read` |
| `present(terminal, info)`    | `pane.report_metadata`                                                                                           | block/window labels            | `rename`                                 | the `label` given to `open`                    |
| `prepare(machine)`           | `herdr machine add <target> --remote-session vibest`                                                             | `rex hosts add`                | `tern remote setup`                      | the user prepares the machine                  |
| `attach(machine)`            | `herdr --session vibest`                                                                                         | — (Rex.app)                    | `tern`                                   | none                                           |
| `doctor(machine, harnesses)` | herdr version; each harness's state hook (`herdr integration status`), fix `herdr integration install <harness>` | what rex needs                 | what tern needs                          | `vibest doctor` shows `status` only            |

How the required members map: herdr `tab.create` (env) + `agent.start`, `pane.send_*`, `pane.read`,
`pane.process_info`, `pane.close`; rex `session.new_split` (`command`, env via `/usr/bin/env K=V`), `block.event`,
`terminal.format`, `terminal.process`, `block.close`; tern `split|new tab -- argv` (env via `/usr/bin/env`), `send`,
`capture`, `process --json`, `close`. Remote: herdr `ssh <target> herdr --session vibest remote-api-bridge`
(herdr ≥ 0.9.1 both sides), rex `-S <host>` over Tailscale, tern `tern ssh <target> tern …`.

Core helpers over the interface, so no plugin writes them: `readFile(machine, path)` (local: the file system; remote:
`exec` `cat`), and the hidden-terminal `exec`.

herdr behaviour the in-memory fake (`apps/vibest-herdr/test/fake-runtime.ts`) models: an agent's record outlives its
process, so `session` still answers after the harness exited while `state` answers `not_found`; a pane id handed out
again is a new pane, not the agent that died in it; a resume moves the named agent to the new terminal; closing the
last pane closes its workspace, and a main checkout's workspace takes its linked worktrees' workspaces with it.

`RuntimeError.code`: `not_found`, `busy`, `unreachable` (transient, retried), `incompatible` (needs the user),
`failed` (anything else). `events` carries at least `exited` for each terminal whose program ended or that closed, and
`reset` when the runtime lost track; core then reads each of its terminals once. `state` answers `not_found` when it
names no agent in that terminal, which core reads as absent. `run(terminal, argv)` runs a command in an existing
terminal once its program ended and its shell is back, the counterpart of `open`; without it there is no restart in
place, and `vibest update` and a usage-limit move leave that terminal's agent for the user to restart. `present` gets
the keys `agent`, `harness`, `title`, `definition` and `session` for the terminal and `project` and `live` for the
project's workspace; any other key is the caller's own, and a runtime shows only the keys it knows.

Every runtime plugin passes the shared contract suite (`@vibest/plugin/testing` `runtimeContract`) against a real
local instance: the required members, then each optional one present. It is framework-free and fails with
`ContractFailure` naming the member and why, so a test file or a CLI check can drive it. `prepare` and `attach` are
checked as members only, never run. The suite types into the shell `open` started, so a read proves the program ran
rather than its own echoed command; it follows `events` from the start, so a program that ends on its own is seen
without a `close`, and `process` on it reports `running: false`, then `not_found` once the terminal is gone.

## 4. Choosing a runtime

Several runtimes run at once, on any machine; core routes every call by the Agent's own `runtime.kind`. Each runtime
product keeps one instance per machine (one herdr session `vibest`, one rex server, one tern daemon).

- Each Agent gets its runtime in `agent.start.before` (`event.runtime`, beside `machine` and `harness`). A runtime
  already set by the caller (`--runtime`) or a plugin stands. Next is vibest.json's top-level `runtime`, then the
  parent's runtime, then herdr, then the only online runtime. The product reads the configuration on every start.
  An unavailable configured or parent runtime is refused, never silently replaced by another runtime. Main agents
  count as parents too; their rows are read through `coordinatorOf`, not the worker-only `getSession`.
- A main Agent defaults to the positively identified caller terminal's runtime. An explicit/configured different
  runtime opens a new terminal instead of registering the caller's terminal under the other runtime. Outside any
  runtime the default remains herdr, then the only online runtime. Subagents open near their parent; reachability
  can be proved at that parent endpoint even when the default server of the same runtime kind is offline.
- None online: refused, listing each runtime and why. vibest never installs a runtime locally.

### Identifying the caller terminal

A runtime may expose `caller: { env, detect }`. Environment keys and terminal/server encodings belong to the plugin.
`detect(values)` returns no candidate, or `{ terminal, live, localRootPid? }`; live is shell/root liveness, not
`process.running` (an idle shell is live). Missing/finished terminals are false; unavailable or incompatible
endpoints remain typed errors. Detection must not start a runtime or query its default/focused terminal.

The CLI obtains the installed key union with `Caller.Keys`, then sends only those values, its own PID, the key
snapshot and an optional explicit runtime filter through `Caller.Detect`. Plugins run only in vibestd, after
activation settles. Each detector gets only its own declared values, has a two-second deadline, and runs with at
most eight concurrent probes. Undeclared keys and values over 4096 characters are refused. Neither raw environment
values nor detector error messages are logged or returned in diagnostics. Key changes between calls and registry
changes during detection return unresolved; the caller retries rather than using a stale plugin snapshot. Ping
advertises the additive `callerRuntime` capability; the database and protocol generation do not change.

Shared code in `core/caller-runtime.ts` chooses among live local roots, without runtime-name precedence:

1. A unique matching controlling tty wins; when either tty is unavailable, a matching process session can win.
2. Otherwise the nearest root on the caller's parent chain wins, including the caller itself, bounded to 64
   processes with cycle detection. A known different tty excludes that ancestor. Unresolved competing roots
   prevent ancestry-only selection, but do not outweigh a positive direct tty/session match.
3. A sole live but unrelated terminal is never adopted. Missing facts, foreign namespaces, ambiguity and stale
   context are explained and require `--runtime`. Explicit runtime selects eligible candidates, not proof of
   membership: a mismatched candidate causes a new terminal to open, never adoption of the stale ID.

The existing Processes platform boundary supplies process facts: macOS `proc_pidinfo(PROC_PIDTBSDINFO)` plus
`getsid`; Linux `/proc/<pid>/stat` with PID and mount namespace identities. Neither reads stdio, argv nor
environments. Zombie/exited roots cannot match. Detection rechecks the selected terminal, caller and root start
tokens; the CLI detects again immediately before main-session registration. Normal runtime calls still handle a
terminal disappearing afterward. No periodic detector or persistent caller cache is added.

Current ceiling: directly connected local runtimes in the daemon's host/PID namespace. Machine-qualified HC
addresses supply no local PID. SSH-forwarded sockets and remotely forwarded runtime variables are unsupported;
a local-looking socket alone does not authenticate a remote process namespace. tmux or a harness-created PTY may
have no installed provider for the direct terminal and require explicit placement. Neither server records the
original process start token, so reuse of an already stale server PID before the first inspection cannot be ruled
out cryptographically. Environment hints and these checks are placement evidence, not caller authentication.

`pnpm e2e S35` creates its own herdr session and isolated core, opens an HC shell from the herdr pane with both
real terminal identities, types `vibest` without `--runtime`, and proves that main and its subagent stay in HC
while a separately started agent uses herdr. The user's herdr session and default core are never queried.

## 5. Agent state, one direction

- The harness integration (the plugin vibest loads into each CLI agent) writes only OSC 7501 status to its tty. It sends
  each turn start (the user's prompt) and turn end (the result) to vibestd as the harness's raw event: RPC `Prompt` and
  `TurnEnd` on vibest.sock (2 s per try, one retry 300 ms later, long enough for a vibestd handoff to listen again;
  only when the connection could not be made at all, since a request that may have been sent may have been handled,
  and a second turn end would be delivered twice), or the HTTP hook routes (Claude). vibestd keeps them in memory
  (no file) and checks the session: the turn end becomes its `turn.end` event and result row.
- Core follows each Agent with `events` and `state` when present; it never polls `process`. When a turn ends (state
  idle after working, or the process exited), core takes the reported turn end and delivers the result. A turn end
  vibestd had not written when it stopped is lost; reconciliation records that turn lost.
- Ready for input: `state` idle, else the adapter's ready pattern on `read()`. A process that exits before its turn
  ends loses the round, as today.

### Terminal status ownership

One terminal has one status writer: a harness with native OSC 7501 support owns its reports.
Pi added native reporting in 1.1.0 (upstream #10607, commit `503c60552`): working for runs/compaction, blocked for
dialogs/login, done on success, error on failure, idle at startup/abort. Its renderer owns permission/question/auth
kinds and restores the prior state when a dialog closes. Vibest writes no Pi status and leaves its supported
`PI_PROGRAM_STATUS=0|1` override alone. Older Pis have no fallback status writer.
Pi UI widget kinds describe how a prompt is drawn, not why it blocks, so vibest never maps them to permission,
question or auth; an unknown blocked reason would omit kind, and native reports are left unchanged.

Cursor writes working before its prompt RPC and idle for accepted response/stop hooks. Its public hook API has
no paired permission/question/auth waits, so it never writes blocked. Guard denials remain permission decisions,
not evidence that a human is being asked. Cursor idle relies on `afterAgentResponse` firing every turn.

Claude Code owns its OSC 7501 output; vibest adds no second writer. Claude negotiates support with the terminal
and reports native `working`, `blocked` (including permission/question/auth kinds), `done`, interrupted `idle`,
and `error`. Successful `done` is intentionally not normalized to `idle`: both are non-working; herdr-app uses
the distinction for its unseen mark. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` disables this native reporting too.
Live-checked on Claude Code 2.1.318 and 2.1.319; older versions have no guaranteed coverage or fallback writer.

`pnpm e2e T1` launches the built integrations in real Claude and Pi with held fake models, through a test-only
runtime plugin into its own herdr-core, and exercises the shipped Cursor hook script in a real PTY. Its HOME,
HC_SESSION, HC_SOCKET and XDG directories are under the test root. The fixture is not a shipped runtime adapter:
it tests terminal reports, not exit-event recovery. Raw output and timestamped input/output captures stay in
evidence files, never the runner terminal. Claude ignores keys at its first dialog draw; the check waits for
visible dialog text, pauses, reads it again, then answers only the scratch action.

Caller detection now supports HC coordinators (S33–S35), but T1's coordinator OSC assertions remain a separate
follow-up. Do not forge herdr identity for them. Add this check: launch a real Claude and Pi coordinator through built `vibest --harness
<harness> --runtime hc --headless` in the isolated core; hold its fake model and assert native working, complete
it and assert native done, then start another turn and interrupt it to assert idle, with the loaded vibest
integration and no competing OSC writer. This is independent of worker result coverage. In the same follow-up,
remove Cursor's coordinator exclusion from terminal status reporting and verify working/idle there; terminal
status must not inherit the coordinator exclusion used for result reporting.

The fake HTTP 401 authentication_error check records Claude's actual retry/working classification; it does not
claim that every provider 401 opens an auth dialog.

## 6. Machines

```
vibest machine add <id> <target> [--runtime <kind>] [--label <label>]   # again with another --runtime adds it
vibest machine list [--json]     # id, runtime, target, status, platform, vibest version, harnesses there
vibest machine check [<id>]
vibest machine remove <id>       # forgets it; stops nothing on the machine
```

`add`, stopping at the first failure with its reason:

1. The runtime's `prepare(machine)` when it has one (an interactive step it needs is passed through to the terminal).
2. `status(machine)` is online.
3. On the machine, through `exec`: `~/.vibest/runtime/<version>/` (the vibest binary for its platform and the harness
   integrations, copied from this install, checksum, smoke test, atomic move); probe `command -v pi claude
   cursor-agent git` in a login shell.
4. Save `machines.<id> { label, runtimes: { <kind>: <target> } }` in the user configuration and print what the probe
   found. A machine can have several runtimes; `add` with another `--runtime` adds one.

`add` again refreshes 1–3.

## 7. Running an Agent on a machine

- `agent.start.before` gets `machines[]` (`{ machine, runtimes: [{ kind, status }], harnesses }`) and may set
  `machine` and `runtime`; the builtin plugin keeps `local` and the parent's runtime (§4). Core checks after the chain:
  the runtime online on that machine, harness there; else refuses with the reason.
- The Project must have a git remote, and the machine uses the same remote. The mirror is
  `<remote VIBEST_HOME>/projects/<project id>`: cloned on first use, fetched after. The start commit must already be on the
  remote, else refused ("push first"). The Workspace is `git worktree add --detach <commit>` there, plus the
  `.worktreeinclude` files (size-capped). Work comes back by the Agent pushing its branch, as locally.
- Offline (`status` not online, or `unreachable` errors): the machine's Agents show `offline`, not failed; their
  rounds stay open; on `reset` or the next online check core re-reads `process` and `state`, and takes any reported turn end.

Out of scope now: Agents on a remote machine starting their own subagents, load balancing, password ssh.

Core has one machine today, `local` (`core/runtimes.ts`): a runtime that registers or comes back publishes one
`live.reset` for it, `readFile` reads the local file system (another machine will read through the runtime's `exec`,
else the hidden-terminal fallback), and `machines[]` lists only `local`. A runtime with several machines publishes one
reset per machine. Runtime plugins register and unregister one at a time (one supervisor consumer), and a
registration's events end with its plugin's scope.

## 8. Order of work

1. API in `@vibest/plugin`; core on it (required members + fallbacks); harness integrations report turn events and
   OSC 7501; herdr becomes the builtin `runtime-herdr` plugin. Gates and e2e unchanged.
2. `vibest machine`, remote herdr, the machine flow above; proven on voyracloud (Linux) and macbook-pro-m1 (macOS).
3. `runtime-rex` and `runtime-tern` (parallel), each passing the contract suite.
