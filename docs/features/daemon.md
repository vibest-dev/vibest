# Daemon and protocol

vibestd is the one daemon behind every vibest command in a vibest home. Each capability below says what it is and when
it counts as working.

## D1. Status without a daemon

`vibest status` when no vibestd runs prints this client and says vibestd is not running. It starts nothing.

## D2. Starting the daemon

`vibest daemon` starts vibestd in the background. A second `vibest daemon` exits 0 and starts no second one: the vibest
home holds one daemon's pid, and both commands exit 0.

## D3. One daemon per home

`vibest daemon --foreground` while one already runs does not take over: it says vibestd is already running, exits 0, and
the running daemon is untouched.

## D4. Restart when idle

`vibest daemon restart` with no agent working replaces vibestd: a new process answers on the same socket.

## D5. Protocol version

A request without the vibest protocol header, or with an old value, is refused as a protocol mismatch, and the daemon
keeps answering.

## D6. Caller roles

A caller claiming an agent or a session that vibestd does not know is refused (an invalid caller, or forbidden).

## D7. Restart while agents work

`vibest daemon restart` while agents work replaces vibestd. The agents keep running, queued messages are kept, and
results and sends still arrive after the restart; agents on an old integration can be restarted in place. A daemon
operation that has not finished refuses the restart and names itself.

## D8. Update with work in flight

`vibest update` while an agent is mid-execution hands vibestd over without cutting the execution off: the agent's execution keeps
running and its reply arrives, and an agent on an old integration is restarted in place and continues its execution. The
handoff waits for unfinished daemon operations and deliveries; if they do not settle, it refuses and names each
blocker.

## D9. Update from the registry

`vibest update` from npm's registry finds a newer published release, asks before installing it, and after the
confirmation the running vibestd is replaced by the new version.

## D10. Reading the event log

`vibest events --session <id>` prints that session's facts, one JSON line each, in `seq` order from 1, the same types the
session recorded. `vibest events` prints every fact, each aggregate's in `seq` order. `--follow` keeps running and prints
facts committed after it started, once each. `--session <id> --after <seq>` prints only that session's facts with a greater `seq` (the last line already seen is the cursor), then follows if `--follow` is given, with no gap and no repeat; `--after` without `--session` is refused. Without `--follow` the output ends at the last fact recorded when the command started. An unknown session fails with NoSuchSession and prints nothing.

## D11. Stopping is bounded

When vibestd is asked to stop (SIGTERM, SIGINT, SIGHUP on a terminal, or a stop request such as `vibest daemon restart`),
it exits within 10 seconds plus a short log flush even if a layer, for example a plugin teardown, never finishes
releasing. The log and stderr name each layer still releasing and for how long; a second signal during the stop exits at
once. A `vibest daemon restart` of such a vibestd still brings the new one up: the start and readiness waits are longer
than the deadline.

## D12. Log file

vibestd writes `vibestd.log` in the vibest home itself. `vibest daemon --foreground` prints that path before its output goes there. A start that takes the daemon lock over a log larger than 10 MiB leaves at most the last 5 MiB, from a line boundary, and later lines follow that tail. A second start, while one is already running, does not trim. It does not trim again until the next start.
