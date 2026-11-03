# Update and Restart

1. No hot reload.
2. `vibest update` hands vibestd off to the new version: it plans to keep running, hand off or restart, and says why.
3. Then it asks once to restart every agent still on the old integration. Yes restarts them in place (see [runtime-boundary.md](runtime-boundary.md) 4) with the same vibest session and harness conversation; an interrupted turn gets `continue`.
4. There is no separate restart command. Mismatch messages name `vibest update` ([protocol-versioning.md](protocol-versioning.md) 3).
5. An installed version directory is not deleted while a running session uses it.
6. A restart in place: mark the session restarting in its row, SIGTERM to the harness pid only (never its process group; the integration reports the pid with its ready report), then the runtime's optional `run` starts the harness again in the same terminal once its shell is idle. A subagent gets its harness argv on its conversation; a main agent gets `vibest integration start <id>`, which builds the harness command from its row. The mark is cleared when the integration reports ready. The harness is the terminal's foreground program, as for a first start: no wrapper loop.
7. Core checks only that `run` exists. An agent whose runtime has no `run`, or whose harness never reported its pid, is not restarted; the update names it and says to restart it by hand.
8. A usage-limit move takes the same path: only the limited harness ends and the next harness runs in the same terminal.

Status: decided, planned in the update-restart pipeline plan (`pipeline-update-restart-plan.md` in the project scratch). 1 to 8 are built on `feat/update-restart-agents-v2` (runtime-herdr implements `run`). Known limits: a pane with no shell, a remote herdr, another vibest earlier on PATH, typing in the terminal while `run` types, and a usage-limit move whose runtime has no `run` or whose harness reported no pid (it still closes the pane and opens another).
