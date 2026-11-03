# Runtime plugins and machines

The agent runtime is where Agents' terminals live: herdr, rex and tern today, other products later. vibest owns the
flow (who runs, where, what came back); a runtime owns terminals and how to reach a machine. The API is
[`runtime-api.ts`](runtime-api.ts). This replaces the herdr-shaped `RuntimeClient` (architecture §10) and answers open
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

An Agent row stores `runtime { kind, address: Terminal }` (JSON, no DDL).

## 3. The interface

Required: `kind`, `status(machine)`, and on terminals `open`, `send`, `read`, `process`, `close`. `open`'s input
beside the placement (`project`, `cwd`, `argv`, `env`, `label`) carries `near` (beside that terminal when possible),
`split` (a split beside `near` instead of a tab of its own, `vibest run --peer`) and `focus` (the user is waiting to
see it); each is the runtime's to honor as it can.

| Optional                        | herdr                                                                                                            | rex                            | tern                                     | Core's fallback when absent                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `state(terminal)`               | detected                                                                                                         | OSC 7501 the program wrote     | OSC 7501 (window side)                   | harness integration only                       |
| `session(terminal)`             | the agent record's conversation id                                                                               | —                              | —                                        | the harness's reports only                     |
| `events` (exited, state, reset) | `events.subscribe`                                                                                               | `session.attach_all`           | `tern events`                            | poll `process`                                 |
| `exec(machine, argv, cwd)`      | —                                                                                                                | detached block, `child_exited` | `new tab --keep-open`, `wait`, `capture` | hidden terminal: `open`, wait for exit, `read` |
| `present(terminal, info)`       | `pane.report_metadata`                                                                                           | block/window labels            | `rename`                                 | the `label` given to `open`                    |
| `prepare(machine)`              | `herdr machine add <target> --remote-session vibest`                                                             | `rex hosts add`                | `tern remote setup`                      | the user prepares the machine                  |
| `attach(machine)`               | `herdr --session vibest`                                                                                         | — (Rex.app)                    | `tern`                                   | none                                           |
| `doctor(machine, harnesses)`    | herdr version; each harness's state hook (`herdr integration status`), fix `herdr integration install <harness>` | what rex needs                 | what tern needs                          | `vibest doctor` shows `status` only            |

How the required members map: herdr `tab.create` (env) + `agent.start`, `pane.send_*`, `pane.read`,
`pane.process_info`, `pane.close`; rex `session.new_split` (`command`, env via `/usr/bin/env K=V`), `block.event`,
`terminal.format`, `terminal.process`, `block.close`; tern `split|new tab -- argv` (env via `/usr/bin/env`), `send`,
`capture`, `process --json`, `close`. Remote: herdr `ssh <target> herdr --session vibest remote-api-bridge`
(herdr ≥ 0.9.1 both sides), rex `-S <host>` over Tailscale, tern `tern ssh <target> tern …`.

Core helpers over the interface, so no plugin writes them: `readFile(machine, path)` (local: the file system; remote:
`exec` `cat`), and the hidden-terminal `exec`.

Every runtime plugin passes the shared contract suite (`@vibest/plugin/testing` `runtimeContract`) against a real
local instance: the required members, then each optional one present.

## 4. Choosing a runtime

Several runtimes run at once, on any machine; core routes every call by the Agent's own `runtime.kind`. Each runtime
product keeps one instance per machine (one herdr session `vibest`, one rex server, one tern daemon).

- Each Agent gets its runtime in `agent.start.before` (`event.runtime`, beside `machine` and `harness`). The builtin
  plugin: the parent's runtime when it is online on the chosen machine (the subagent opens beside its parent), else
  the configured `runtime`, else herdr, else the only one online. Core checks after the chain: that runtime online on
  that machine, else refuses with the reason.
- The main Agent: `vibest --runtime <kind>`, else the configured `runtime`, else herdr, else the only one online.
- None online: refused, listing each runtime and why. vibest never installs a runtime locally.

## 5. Agent state, one direction

- The harness integration (the plugin vibest loads into each CLI agent) writes only OSC 7501 status to its tty. It sends
  each turn start (the user's prompt) and turn end (the result) to vibestd as a neutral integration event on
  vibest-http.sock (`/events`; a shell-hook CLI's raw hook through `/hook`). vibestd keeps them in memory
  (no file) and checks the session: the turn end becomes its `turn.end` event and result row.
- Core follows each Agent with `events` (else polling `process`) and `state` when present. When a turn ends (state
  idle after working, or the process exited), core takes the reported turn end and delivers the result. A turn end
  vibestd had not written when it stopped is lost; reconciliation records that turn lost.
- Ready for input: `state` idle, else the adapter's ready pattern on `read()`. A process that exits before its turn
  ends loses the round, as today.

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
  `<remote VIBEST_HOME>/projects/<key>`: cloned on first use, fetched after. The start commit must already be on the
  remote, else refused ("push first"). The Workspace is `git worktree add --detach <commit>` there, plus the
  `.worktreeinclude` files (size-capped). Work comes back by the Agent pushing its branch, as locally.
- Offline (`status` not online, or `unreachable` errors): the machine's Agents show `offline`, not failed; their
  rounds stay open; on `reset` or the next online check core re-reads `process` and `state`, and takes any reported turn end.

Out of scope now: Agents on a remote machine starting their own subagents, load balancing, password ssh.

## 8. Order of work

1. API in `@vibest/plugin`; core on it (required members + fallbacks); harness integrations report turn events and
   OSC 7501; herdr becomes the builtin `runtime-herdr` plugin. Gates and e2e unchanged.
2. `vibest machine`, remote herdr, the machine flow above; proven on voyracloud (Linux) and macbook-pro-m1 (macOS).
3. `runtime-rex` and `runtime-tern` (parallel), each passing the contract suite.
