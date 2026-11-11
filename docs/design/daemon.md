# Daemon

Implementation notes for [surfaces and protocol](architecture.md#13-surfaces-and-protocol).

## Lifecycle and replacement

From omac `daemon.ts`, `drain.ts`, `replace.ts` (copied): a start lock held by `flock` on
`vibestd.pid` (below); a socket that answers is never unlinked; the instance (pid, start id, argv) is in Ping and
`vibestd.pid`; only the user's command starts the daemon, never an agent's (it would inherit the agent's
sandbox). `daemon restart` and `update` replace it only after `y` on a terminal, while agents keep running: the old
one refuses new changes with `DaemonStopping`, drains its own operations (admitted requests, deliveries, launches,
archives; `core/drain.ts`) for up to 5 s, and leaves pending Messages in sqlite for the next one. Drain counts
daemon operations, not agent lifetimes. While it drains, only a settlement of work already started is admitted;
other work waits and wakes once a refused Stop reopens. The start lock's
file handle must stay referenced for vibestd's whole scope: Bun collects an unreferenced handle within seconds (on
Linux in about 2-3 s without a forced GC) and the lock goes with it while the process lives, so the finalizer that
closes the handle is what keeps it (`daemon.test.ts` checks it under `Bun.gc`).
On Bun, `vibestd.pid` is both the record and the start lock: `flock` on the file itself, so readers still read it
while it is held and a killed vibestd leaves no stale lock. It is written in place and never replaced (a new inode
would be unlocked) or unlinked (a contender may have the old inode open); release empties it. A failed `flock` is
taken as held by another process without reading errno.
A replacement never signals vibestd and never removes its socket or lock; the outcome is what Ping shows afterwards.
Before it asks or sends anything, `daemon restart` has the new binary run `vibest daemon import-check` (as a handoff
does); when that fails, the running vibestd is not stopped and the message names the cause and the steps to go on.
One socket and one lock leave no way to have the new vibestd answer before the old one stops, so this check is what
keeps a working vibestd from being stopped for one that cannot open the database; a new vibestd that fails after the
stop for another reason gets the command that starts the old binary again, when it is another file.
It sends one `Daemon.Stop` (the same call on every protocol since it was added, so in the running vibestd's
protocol), never again: only one of vibestd's own refusals, decoded, changes nothing; an accepted, lost or
undecodable reply, or none, is a hint and Ping decides. A vibestd before 0.0.1-beta.10 refuses while any agent or
queued message is active. The client waits 55 s for the reply (above an older vibestd's two 20 s quiet checks and a
5 s drain, so only a wedged vibestd reaches it) and 15 s for the old one to stop answering; nothing answering is not
proof it exited, so the new vibestd waits for the lock, boundedly. With `--version` (15 s) and the new start, a
replacement ends in about two minutes whatever the other side does, not counting the wait for the yes.

Every start of vibestd (`vibest daemon`, the auto-start of a CLI or a harness plugin, the new vibestd of a handoff)
goes through `spawnDaemon`: a shell that starts vibestd in the background and exits, and that the caller waits for.
vibestd is then adopted by launchd on macOS, and on Linux by the nearest subreaper (such as `systemd --user`) or
init, so a long-lived caller such as a Pi process or an old vibestd never leaves it a zombie. A process is exited for vibest (`liveness`) when `kill(pid, 0)` fails or it is a
zombie (`sysctl` `KERN_PROC_PID` on macOS, `/proc/<pid>/stat` on Linux); every wait for an old vibestd or harness to
exit uses it.

`vibest update` sends `Daemon.Handoff` the same way, in the running vibestd's protocol, so a newer vibest hands over
a vibestd of any older protocol that has the `handoff` capability. A handoff (like a Stop) accepts the stop in the
same step that finds vibestd idle, and only then starts the new vibestd: from then on no execution end or other work is
admitted, so a started new vibestd always takes over, and a refused handoff has started nothing.

After `vibest update` installs another version and vibestd answers Ping with that version, the old process does not
offer the agent restarts itself: across a protocol change vibestd refuses it (`IncompatibleDaemon`). It runs the
installed binary as `<installed vibest> update --restart-agents-after <pid> [--yes]` on the same terminal and exits
with its status. The child runs only the restart offer, with `--yes` deciding as for `vibest update`, and passes
`<pid>` (the parent's) to `Agents.Restart` as `after`, so a main Agent that ran `vibest update` is restarted only once
the outer command has exited. This hidden flag is a contract between versions: the old binary writes the call, the
new one reads it, so every later version keeps accepting `--restart-agents-after <pid>` and `--yes` with this meaning.
When vibestd still runs another version (a declined restart), the old process offers the restarts itself. A CLI older
than vibestd is told to run `vibest update` again, or how to stop vibestd by hand to keep the older version.

## Daemon start

In `packages/server/src/daemon.ts`: take the flock on `vibestd.pid`, retrying while it is busy (a
vibestd whose socket closed may still run its finalizers, or another starter is mid-attempt; each attempt is a fresh
connection) and exiting once a vibestd that holds it answers; a handoff's new vibestd waits for the old one's lock,
not its socket, which answers until the old one has drained. With the lock held, whatever still answers on
`vibest.sock` took none (an older vibestd or another program): its socket stays and the start fails, after three
Pings, since one can outlast its 1 s timeout on a loaded machine. Else the socket is unlinked, a handoff backs up the
database the old vibestd left before this one opens and migrates it, sessions are recovered and the socket served.
The lock is taken first and released last, after the socket server has closed and removed its path, so a successor's
socket is never unlinked. The PID line is written into the locked file, and releasing the lock empties it; it is for
people to read, since a stale file's PID may belong to another process by now, and nothing signals it. An accepted
`Daemon.Stop` keeps a 200 ms grace (`STOP_REPLY_GRACE` in `packages/server/src/daemon.ts`) before the server closes so its reply is written; a lost reply is still handled by
the client, which watches Ping. Each daemon has its own plugin registry (a service, never a global), and one event bus that
Db and Runtimes depend on, so a commit is visible to whoever subscribed first. The services form one graph
(`packages/server/src/app.ts`, see [architecture §5](architecture.md#5-service-composition)): a service is built after
every node in its `deps`, and the nodes the host supplies are replacements, so the daemon and the tests compile the
same graph. The RPC and HTTP servers list the whole services group (`packages/server/src/services.ts`) in their
`deps`, so the socket and the HTTP port bind only after every service is built, whatever the order of the roots. The main Agents' `vibest --env` values live
in vibestd's memory only (never stored, logged or sent); a handoff passes them to the next vibestd in its environment
(`VIBEST_HANDOFF_ENV`), which `vibest daemon --import` reads and removes before anything starts, and a handoff first
has the new binary check read-only that it can open the database (`vibest daemon import-check`, waited on for up to 120 s). The pairs go on the
pane's environment, not into the typed command, so they stay out of the shell history; the pane gets them in one
variable a shell rc does not set, since an rc that exports the names themselves would win.

## Admission while draining

Changes are counted at the RPC and HTTP entry until they end, failed or interrupted ones too, and refused once a
`Daemon.Stop` drains (`DaemonStopping` over RPC, 503 over HTTP), except settlements of work already handed out: a
hook's execution start (`Prompt`) or execution end (`ExecutionEnd`) and an inbox ack. While it drains these are still admitted;
after the Stop is accepted they are refused too. Refused while draining, a spawn's first execution would never show its
pickup proof (its launch then holds the drain open) and an execution end would lose its result. An execution end is one
transaction that writes the round's `execution.ended` with its reply, without the session lock; a write that fails fails the request, so the caller sees a
failure, not a silent retry. An execution start is stamped once, when the hook arrives: `userPrompt` notes the start before
it may wait for the session's lock, held through a send's whole confirm, and stamps the round with the same time, so
the pending send sees its pickup proof while it still waits.

## Session requests

Middleware checks caller and protocol headers before a handler runs and never calls
`client.annotate`, so a later request on the same socket starts clean. A session's environment must name its own
project (`VIBEST_PROJECT_ID`); one naming another or none is refused, over RPC as over HTTP. The integration version
and protocol a session's request carries are recorded on its row when they changed, whether or not the protocol
matches and before the protocol check, so an agent left on an old integration is known and `vibest update` restarts
it; the `vibest` CLI an agent runs sends no plugin version and records nothing. The harness conversation id is taken
from the session's own harness only, latest wins (a `/clear` changes it): a process of another harness under the same
session id (an old main Agent after a switch) changes nothing. ACCESS roles: `open` (protocol only), `session` (a
subagent), `agent` (a main Agent or the command line), `coordinator`, `owner` (a main Agent of the session's Project,
or the command line) and `self` (a subagent's own terminal for its own id, or the command line at the Project root for
its main Agent, its start after a restart). One main Agent per Project: every start passes one check that holds the
Project's lock through the launch, as a stop does, so two starts at once cannot both pass; the check fails open
(nothing running) when the runtime cannot be reached or cannot tell, and a main Agent that `vibest update` is
restarting counts as running. A stop of a main Agent that is restarting is refused rather than waited for, since its
next harness starts in seconds. A main Agent's working directory places it only in a Project without a directory;
otherwise it starts sessions in its own Project wherever its shell is.
