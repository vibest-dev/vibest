# Update and Restart

1. Integrations reload in place where the harness can. Each harness loads vibest's plugin from `${VIBEST_HOME}/harnesses/<id>` (`Layout.harnessPlugin`), the same path for every install; vibestd rewrites it from its own bundled plugin when it starts, file by file, each a temp file renamed over its target, the hooks module last (`Harness.sync`). Claude Code reloads its hooks module there by itself when the running turn ends, or at the next turn start, never mid-tool: same process, same conversation, nothing typed. What each harness provides for this is in [harness-integration.md](harness-integration.md) 7: today only Claude reloads; Pi is restarted in place; Cursor is restarted by hand.
2. `vibest update` hands vibestd off to the new version: it plans to keep running, hand off or restart, and says why.
3. Then it lists every agent still on the old integration. One whose integration reloads (1; its ready report names the synced directory as where it was loaded from) is said to take the new one in place and is not restarted. For the others it asks once to restart them in place (see [runtime-boundary.md](runtime-boundary.md) 4) with the same vibest session and harness conversation; an interrupted turn gets `continue`.
4. `vibest daemon restart` offers the same in-place restart once it has replaced vibestd: both commands ask once and restart through the same code (`restartAgents` in the CLI, `packages/core/src/restart.ts`). There is no other restart command. Mismatch messages name `vibest update` ([protocol-versioning.md](protocol-versioning.md) 3).
5. An installed version directory is not deleted while a running session uses it.
6. Only an agent that does not reload (1) is restarted. A restart in place: mark the session restarting in its row, SIGTERM to the harness pid only (never its process group; the integration reports the pid with its ready report), then the runtime's optional `run` starts the harness again in the same terminal once its shell is idle. A subagent gets its harness argv on its conversation; a main agent gets `vibest integration start <id>`, which builds the harness command from its row. The mark is cleared when the integration reports ready. The harness is the terminal's foreground program, as for a first start: no wrapper loop.
7. Core checks only that `run` exists. An agent whose runtime has no `run`, whose harness never reported its pid, or whose harness has no integration that reports its pid and readiness (Cursor) is not restarted; the update names it and says to restart it by hand. A harness with no integration is never listed as outdated.
8. A usage-limit move takes the same path: only the limited harness ends and the next harness runs in the same terminal.
9. A main agent moved from another terminal (`vibest` there, answered y) ends the same way: SIGTERM to the pid it last reported, its terminal and shell kept, then it starts in the new terminal. While a restart is between its harnesses, that start is refused and nothing is signalled.
10. An integration that reloads is reload-safe: what must outlive a reload is in harness state that survives it (Claude `$.state`: the inbox queue, rows taken and not acked, reports vibestd did not take), work that must finish is awaited inside a hook (the turn end, the prompt report, the ack, which comes as soon as a line entered), and only the newest load polls. A turn end carries its turn id and vibestd records it once, so sending it again is safe. A new version keeps every native call the previous one makes.

Status: 2 to 9 in force on main (runtime-herdr implements `run`; core in `packages/core/src/restart.ts`). 1, 3, 6 and 10 as written here are on `feat/lossless-update` (the lossless-update plan's steps 1 and 2: the synced plugin directory and the reload-safe Claude module). Planned next: agents that cannot reload restart only once their turn has ended, with no `continue`; skills refresh with `reload-plugins` once per version. Pi does not hot reload (decided).

Known limits:

- A pane with no shell, a remote herdr, another vibest earlier on PATH, and typing in the terminal while `run` types.
- A usage-limit move whose runtime has no `run` or whose harness reported no pid still closes the pane and opens another.
- `run`'s idle check counts `sh` as a shell, so in a main agent's pane typing can start between the harness exit and `exec $SHELL` (the tty keeps the text).
- On the first update from a version before this branch, subagents on the old integration have reported no pid and are listed as "restart it yourself".
- The handoff's database backup is kept per version and never pruned.
- A subagent result the interrupted turn wrote between `turnPromptedAt` and the restart is overwritten by the continue turn.
- An idle Claude reloads up to 30 s after the sync: its plugin directory watch polls every 30 s once the person is idle.
- A reload that lands at a turn start runs that turn's hooks in two module versions (accepted; the module is reload-safe, nothing more).
- Claude's skills and commands refresh only at its next start; the reload is of the hooks module alone.
- A prompt report sent again after its answer was lost is recorded twice: only turn ends carry an id.
- Claude's `/clear` starts an empty `$.state`: rows queued then come again after their lease (late, not lost).
- Cursor keeps its old integration until it is quit and started again, and the update does not name it yet.
- An agent started before the synced directory existed (an install's own plugin directory) does not reload; it is restarted as before.
