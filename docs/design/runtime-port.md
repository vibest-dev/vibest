# Runtime plugins and machines

The agent runtime is where Agents' terminals live: herdr, rex and tern today, other products later. vibest owns the
flow (who runs, where, what came back); a runtime owns terminals and how to reach a machine. The API is
[`packages/plugin/src/runtime.ts`](../../packages/plugin/src/runtime.ts); `packages/runtime-herdr` is a runtime plugin
built on it. This replaces the herdr-shaped `RuntimeClient` (architecture §10) and answers open
question 3 (§12, §17).

## 1. Principles

1. **Simple, clear, extensible.** One interface, `RuntimeDefinition`: seven required members, the rest optional. The API
   ships with vibest and has no version of its own: additions are optional members; a breaking change ships in a
   vibest release and plugins update with it. Core checks whether an optional
   member exists, never which runtime it is. One error type with a `code`.
2. **Runtimes are plugins, several at once.** A runtime plugin adds a `RuntimeDefinition` with an `id`
   (`context.runtime.transform((editor) => editor.add(definition))`, beside `context.agent.hook`); another plugin may
   `update` or `remove` it the same way, and removing the plugin restores what it changed. It is a provider core calls, not a hook listener. herdr, rex and tern ship as builtin
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

Required: `id`, `status(machine)`, `events` (exited, state, reset, and seen from a runtime with `seen`: core reads a
runtime only when one arrives, and once at start and on a reset), and on terminals `open`, `send`, `read`, `process`, `close`. `open`'s input
beside the placement (`project`, `cwd`, `argv`, `env`, `label`) carries `near` (beside that terminal when possible),
`split` (a split beside `near` instead of a tab of its own, `vibest run --peer`), `focus` (the user is waiting to
see it) and `remote` (another machine's vibestd started the agent, `Peer.Spawn`; herdr then opens it in its default
session `default` and ignores `near`); each is the runtime's to honor as it can.

`name` is optional: the word a place uses for this runtime. A place reads `<name> <address>`, or `<name> (not placed)` when the address is empty, and a remote address keeps its `@machine`. With no `name`, the place uses `id`. herdr leaves `name` unset, so a place says `herdr`. herdr-core sets `herdr-core` and keeps id `hc` (`--runtime hc`, and the id stored on a row, do not change).

| Optional                     | herdr                                                                                                            | rex                            | tern                                     | Core's fallback when absent                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `state(terminal)`            | detected                                                                                                         | OSC 7501 the program wrote     | OSC 7501 (window side)                   | harness integration only                       |
| `session(terminal)`          | the agent record's conversation id                                                                               | —                              | —                                        | the harness's reports only                     |
| `events` (required)          | `events.subscribe`                                                                                               | `session.attach_all`           | `tern events`                            | none: required                                 |
| `exec(machine, argv, cwd)`   | —                                                                                                                | detached block, `child_exited` | `new tab --keep-open`, `wait`, `capture` | hidden terminal: `open`, wait for exit, `read` |
| `present(terminal, info)`    | `pane.report_metadata`                                                                                           | block/window labels            | `rename`                                 | the `label` given to `open`                    |
| `seen`, `see`                | —                                                                                                                | —                              | —                                        | never `done` in Watch                          |
| `prepare(machine)`           | `herdr machine add <target> --remote-session vibest`                                                             | `rex hosts add`                | `tern remote setup`                      | the user prepares the machine                  |
| `attach(machine)`            | `herdr --session vibest`                                                                                         | — (Rex.app)                    | `tern`                                   | none                                           |
| `link()`                     | `{session, version}`: `default`, where remote agents open; `ping` on its socket                                  | —                              | —                                        | other machines cannot show its terminals       |
| `locate(machine, sessions)`  | the saved herdr machine for each B terminal's session; `<B terminal>@<label>`                                    | —                              | —                                        | remote rows: "cannot be shown here"            |
| `doctor(machine, harnesses)` | herdr version; each harness's state hook (`herdr integration status`), fix `herdr integration install <harness>` | what rex needs                 | what tern needs                          | `vibest doctor` shows `status` only            |

How the required members map: herdr `tab.create` (env) + `agent.start`, `pane.send_*`, `pane.read`,
`pane.process_info`, `pane.close`; rex `session.new_split` (`command`, env via `/usr/bin/env K=V`), `block.event`,
`terminal.format`, `terminal.process`, `block.close`; tern `split|new tab -- argv` (env via `/usr/bin/env`), `send`,
`capture`, `process --json`, `close`. Remote: herdr `ssh <target> herdr --session vibest remote-api-bridge`
(herdr ≥ 0.9.1 both sides), rex `-S <host>` over Tailscale, tern `tern ssh <target> tern …`.

`link()` and `locate(machine, sessions)` let one machine show another's terminals (hc implements both:
[runtime-herdr-core.md](runtime-herdr-core.md), [multi-machine.md](multi-machine.md#terminals-on-other-machines)):
`link` is what the same runtime elsewhere needs to reach this machine's terminals, sent in `Peer.Hello`; `locate`
gets each session id with the terminal id that machine reported for it, and answers `missing` when the runtime has no
machine with the link's id, else the local terminal ids of those sessions,
`as` (its name for the machine) and a `note` when it cannot show them. It is read-only and runs inside `vibest ls`.

Core helpers over the interface, so no plugin writes them: `readFile(machine, path)` (local: the file system; remote:
`exec` `cat`), and the hidden-terminal `exec`.

herdr behaviour the in-memory fake (`packages/cli/test/fake-runtime.ts`) models: an agent's record outlives its
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

Several runtimes run at once, on any machine; core routes every call by the Agent's own runtime `id`. Each runtime
product keeps one instance per machine (one herdr session `vibest`, one rex server, one tern daemon).

- A runtime definition may carry a `caller` (`RuntimeCaller`): the environment variables its terminal sets, and how to
  read the terminal (and optionally a machine target) from those values. Definitions declare no priority;
  registration order decides. Without `--runtime`, vibest uses the runtime of the terminal it was started in. When a
  terminal carries both herdr-core and herdr variables (they are inherited), hc wins because the builtin
  runtime-herdr-core registers before runtime-herdr. The CLI and core name no runtime id or variable for detection:
  vibestd reads the callers of the registered definitions (`Runtimes.callers`), so another runtime plugin needs no
  change to be detected. The CLI sends its environment to vibestd, which keeps only the keys some definition's caller
  declared and asks that definition for the machine target. `--session` is an opaque runtime session name.
  Every declared variable set and non-empty means vibest is inside that runtime. One match: that runtime. Several: the
  first registered wins. Builtins come first (herdr-core before herdr), then the plugins directory, then vibest.json
  in the order written. No process tree, tty match, ancestor walk, or detection RPC, and no fallback to herdr or to
  whichever runtime is the only one online. Whenever the registered definitions change, vibestd drops every caller
  variable they declare from its own environment (the platform's `HostEnv.drop`), so a process it starts does not
  inherit a runtime's variables. A plugin cannot read its own caller variables inside vibestd, because those are
  removed; it connects through another variable, as hc uses `HC_SOCKET` rather than `HC_TERMINAL_SOCKET`.
- The main agent (`vibest`) starts in that terminal. `vibest --runtime <id>` overrides the detection and, when this
  terminal is not that runtime's, opens one there. None detected and no `--runtime`: refused, saying to pass
  `--runtime`. A terminal vibestd opened is marked `--in-parent` and already names `--runtime`; that name wins over
  another runtime's variables the shell inherited.
- A subagent (`vibest run`) takes `--runtime <id>` on `Spawn`. Without it, it runs in its parent's runtime. The
  parent lookup includes the coordinator, because `getSession` leaves the live main row out. If that runtime is not
  online, the start fails with the runtime's reason. No other fallback. A user plugin on `agent.start.before` may
  still set `event.runtime`. A runtime already set stands.
- vibest.json's `runtime` key is not a choice. The first time vibestd reads a file that still has it, it warns once
  and ignores the key.
- Core checks after the chain: the chosen runtime online on that machine, else refuses with the reason. vibest never
  installs a runtime locally.

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

Cursor writes no terminal status. Its hooks run detached from the terminal (no `/dev/tty`), so its plugin reports to
vibestd over RPC instead: `sessionStart` is `Session.Ready` (vibest types the first task only then, since herdr-core
has no status for Cursor), `afterAgentThought` and `postToolUse` (and `beforeSubmitPrompt` when the user or project
also hooks it) are a turn start, which vibestd shows as working, and `afterAgentResponse` is the turn end, shown as
idle. Cursor 2026.11.05 does not run a `--plugin-dir` plugin's `stop` hook, and runs its `beforeSubmitPrompt` hook only
when user or project hooks also have one. It reports no permission/question/auth waits, so vibestd never shows it
blocked on herdr-core. A report that does not reach vibestd fails the hook and appends its error to `vibestd.log`.

Claude Code owns its OSC 7501 output; vibest adds no second writer. Claude negotiates support with the terminal
and reports native `working`, `blocked` (including permission/question/auth kinds), `done`, interrupted `idle`,
and `error`. Successful `done` is intentionally not normalized to `idle`: both are non-working; herdr-app uses
the distinction for its unseen mark. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` disables this native reporting too.
Live-checked on Claude Code 2.1.318 and 2.1.319; older versions have no guaranteed coverage or fallback writer.

`pnpm e2e T1` launches the built integrations in real Claude and Pi with held fake models, through a test-only
runtime plugin into its own herdr-core. Its HOME,
HC_SESSION, HC_SOCKET and XDG directories are under the test root. The fixture is not a shipped runtime adapter:
it tests terminal reports, not exit-event recovery. Raw output and timestamped input/output captures stay in
evidence files, never the runner terminal. Claude ignores keys at its first dialog draw; the check waits for
visible dialog text, pauses, reads it again, then answers only the scratch action.

Caller detection is the environment keys in §4. Do not forge a herdr identity in E2E. Still open: launch a real
Claude and Pi coordinator with built `vibest --harness <harness>` inside an isolated hc terminal; hold its fake model
and assert native working, complete it and assert native done, then start another turn and interrupt it to assert
idle, with the loaded vibest integration and no competing OSC writer. This is independent of worker result coverage.
In the same follow-up, remove Cursor's coordinator exclusion from terminal status reporting and verify working/idle
there; terminal status must not inherit the coordinator exclusion used for result reporting.

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
reset per machine. The runtime registry follows every committed change: a definition that appears starts its event
merge and a reset, one that is removed (its transform disposed or its plugin unloaded) stops its merge.

## 8. Order of work

1. API in `@vibest/plugin`; core on it (required members + fallbacks); harness integrations report turn events and
   OSC 7501; herdr becomes the builtin `runtime-herdr` plugin. Gates and e2e unchanged.
2. `vibest machine`, remote herdr, the machine flow above; proven on voyracloud (Linux) and macbook-pro-m1 (macOS).
3. `runtime-rex` and `runtime-tern` (parallel), each passing the contract suite.
