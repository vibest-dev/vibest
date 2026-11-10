# Multiple machines

Every machine runs its own vibestd. vibest mirrors herdr-core: each vibestd has its own id and name (hc `core.json`).

## Identity: `<home>/identity.json`

```json
{ "id": "6f1c…-UUIDv4", "name": "mac-mini", "machine_id": "CE07E143-6F61-59EE-8C81-950A88D74A2A" }
```

- `Layout.identity` is `<home>/identity.json` beside `vibest.db`, so `VIBEST_HOME` moves it. It is state, not
  configuration: `vibest.json` stays the config, and nothing reads identity from it.
- `id`: UUIDv4, what this vibestd presents to another one. `name`: the host name without a domain suffix when the id
  was made, fixed afterwards. `machine_id`: the host's hardware id when the id was made, or `null` when it could not be
  read.
- vibestd reads it at start while holding its start lock (`host.lock(layout.daemonInfo)` in `daemon.ts`), before it
  opens the database, so two starts at once never both make one. Writing is a temp file in the home
  (`identity.json.<pid>.tmp`, fsynced) renamed over `identity.json`, so a reader sees the old file or the new one. A
  file that exists but does not parse, or has no valid UUID `id`, stops vibestd with "<path> is not a vibest identity
  file: move it aside and start again"; vibest never rewrites a file it cannot read.
- It survives restarts, `vibest update` and a handoff. Replacing `vibest.db` alone keeps the identity; deleting
  `identity.json` gives a new one at the next start.
- The host id is read by the platform layer (`packages/cli/src/platform/bun.ts`): on macOS `IOPlatformUUID` from
  `ioreg -rd1 -c IOPlatformExpertDevice` (the value hc stores); on Linux the first line of `/etc/machine-id`, else of
  `/var/lib/dbus/machine-id`. Anything else, a read that fails, is empty or takes more than 2 s: unreadable.

| stored `machine_id` | host id read now | what happens                                                                                                |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| (no file)           | any              | the file is made: a new id, this host name, the host id read (`null` when unreadable)                       |
| X                   | X                | nothing                                                                                                     |
| X                   | Y, different     | a new id, this host name, `machine_id` Y; the warning "this home came from another machine: a new identity" |
| `null`              | readable         | `machine_id` is filled in, the id kept                                                                      |
| any                 | unreadable       | nothing; the id is kept and vibestd logs "host id unreadable: identity kept"                                |

A home copied or restored onto another host gets a new id at its first start there, so two hosts never present the
same id, except where neither can read a host id (a container without `/etc/machine-id`). Data is kept: the new id only
changes what this vibestd presents to others.

## The peer caller and `vibest connect`

Machine A's vibestd reaches machine B's vibestd through one long-lived pipe: `ssh <target> … vibest connect` on B
joins its stdin and stdout to B's vibestd socket, starting B's vibestd when it is not running. Over the pipe A speaks
the ordinary RPC protocol (`packages/client/src/pipe.ts`: a socket over the child's stdin and stdout, pinged every
5 s, dead after 10 s without a frame, no reconnect of its own).

Every request on the pipe carries `vibest-caller: peer`, `vibest-peer: <A's identity id>` and, when it acts for a
project, `vibest-peer-project: <A's project id>`. B refuses every peer request except `Ping` and `Peer.Hello` until
that id has a `peer` row, and refuses every method not in `PEER_CALLS` (`packages/protocol/src/rpc.ts`). This
scopes by mistake, not by trust: whoever can run the ssh command already acts as that user on B.

`Peer.Hello { id, name, callsMe }` answers B's `{ id, name, version }` and upserts the `peer` row (not for B's own
id: A refuses dialing itself). As in herdr-core, B has no command to show or forget the vibestds that dial it: the
`peer` table is the line's own record, and the user manages machines from A (`vibest machine`).

`vibest connect` and `vibest machine` are the user's: `userOnly` refuses them for agents, and the
guard refuses them in an agent's shell.

## Machines: A dials B

`vibest machine add <name> <ssh target>` (user only) connects once, with a 30 s limit: `Ping` (the protocol must be
this one, else `MachineIncompatible` "<name> runs vibest <v> (protocol <n>); run vibest update there"), then
`Peer.Hello`. Only then is the `machine` row inserted, with B's identity id, and that first connection becomes the
supervised one (add dials once); a failure records nothing. It is refused when B answers this vibestd's
own id ("<name> is this vibestd") or an id another row already has (`AlreadyAdded`: "this is the vibestd already
added as <name> (<id8>); use that name"), decided from the result of the `INSERT … ON CONFLICT DO NOTHING`.
`vibest machine ls` shows each row with its connection state, `vibest
machine rm` stops the connection and deletes the row (`UnknownMachine` when there is none), with no checks: agents and undelivered results stay on B.

The ssh command is `ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 [-p <port>] <target>
<line>` (`sshArgv`, `packages/core/src/machines.ts`), found on vibestd's `PATH`; ssh resolves the target, so
`~/.ssh/config` applies, and a login that needs a password or a new host key fails with ssh's message. The line finds
vibest on B (`command -v vibest`, else `$HOME/.local/bin/vibest`) and runs `vibest connect`; exit 127 is reported as
"vibest is not installed on <name>". A name is letters, digits, `-`, `_`, `.`; a target has no `:` before `@` (a
password), no space, no leading `-`, no control character, at most 1024 bytes.

`Machines` keeps one connection per row, started when vibestd starts and when a machine is added; the child is spawned
by the platform layer (`MachineTransport`). Each connect runs `Ping`, then `Peer.Hello`, whose id must equal the row's
`vibestd_id`, then writes `connected_at`. A drop is retried on herdr's ladder, 0.5 s doubling to 120 s, reset after
60 s connected. A protocol mismatch or a different vibestd stops the retries until vibestd restarts or the machine is
added again: "<name> now answers as a different vibestd (<id8>): its database was replaced or the target points
elsewhere; remove the machine and add it again". `vibestd_id` is never updated in place. Connection state
(`connecting | connected | unreachable | different`, since, reason) is memory only, one entry per row.

Known limits: `vibest machine rename` and a "connect now" command are not built; a machine that stays unreachable
notifies nobody.

## B: agents for another machine

`Peer.Spawn` (peer caller, with `vibest-peer-project` naming A's project) finds the one project whose repository
`remote_url` equals `repository` or has the same repository identity as `identity` (a multi-repository project is
refused), checks that the checkout has `commit`
(`Git.hasCommit`: `git cat-file -e <sha>^{commit}`; "<B>'s checkout <dir> does not have <sha>: push it
and fetch it there"), and runs `Sessions.spawn` with the worktree detached at that commit. B learns a checkout with
`vibest project add [dir]` (user only). The session is an ordinary B session with no parent and no report-to; who
started it is one `peer.start` event (peer, project, parent?, reportTo?), written in the transaction that creates
the session row; it has no `report_to` when A's project had no main agent. The forwarded `request` finds the session on a retry.
A `peer.start` row that fails to decode is logged as a warning and the session is treated as local: its results go to
B's own inbox delivery and no outbox row is written for it.

Every result and notice of a peer session with a `report_to` goes to B's `outbox` in the transaction that writes it. B still writes the
inbox row, addressed to the session itself and `dropped`, so `vibest result` on B and a forwarded `Get` read it, and
B's own delivery never sees it. With no `peer` row nothing is queued. `Peer.Outbox` streams
the peer's rows in `created_at` order (insertion order on a tie), then each new one after its commit; an item over
1 MiB is sent cut with `cut: true`. `Peer.Ack { ids }` deletes them. Archiving a peer session deletes its rows.

`List`, `Get`, `Send`, `Interrupt`, `Remove` and `Peek` from a peer resolve a session id only among sessions whose
`peer.start` has that peer and that project; any other session is `NoSuchSession`.

## Repository identity

The same repository is often cloned with different URLs on two machines (`git@github-me:o/r.git` on A,
`https://github.com/o/r` on B), so B does not match `remote_url` as a string alone. The repository identity
(`packages/core/src/repository-url.ts`) is the host in lower case and the `owner/repo` path, without scheme, user,
port, a leading `~/` or `/`, a trailing `/` and a trailing `.git`: `github.com/o/r` for all of `git@github.com:o/r.git`,
`ssh://git@github.com:22/o/r`, `https://github.com/o/r.git` and `https://GitHub.com/o/r`. The host of an ssh form
(scp-like `host:path`, `ssh://`, `git+ssh://`) may be an alias from the ssh config; it is resolved to its real
`HostName` with `ssh -G <alias>` (the `SshHosts` service: a successful lookup is cached per alias; a failure, a non-zero exit or the 5 s limit gives
the alias itself and is asked again next time)
on the machine that reads it: A resolves its own remote, B the remotes of its own checkouts. An https host is never
looked up, nor a bracketed IPv6 host or a one-letter host (a Windows path such as `C:/src/r`): those have no identity. A local path or `file://` URL has no identity and matches only the same string. A sends both the raw URL
and the identity; B takes the checkouts whose raw URL equals A's, and only when there is none compares identities
(so `ssh -G` runs on B only then, for its checkouts at once), and every `NoProject`
message names A's raw URL. `remote_url` is stored unchanged.

Known limits of the identity: the user and a leading `/` or `~/` are dropped from ssh paths, so on a self-hosted plain
ssh server two different repositories (`alice@h:r` and `bob@h:r`, or `h:/srv/r` and `h:~/r`) get one identity; the
`HEAD` commit check then refuses most of them, but not a fork that has the commit. A `HostName` such as
`ssh.github.com` or `altssh.gitlab.com` is not mapped to `github.com` or `gitlab.com`, and paths are compared with
their case; either gives `NoProject`.

## A: remote sessions

`vibest run --machine <name>` (the user or the main agent) sends `Peer.Spawn` over the machine's connection with
the project's one repository's `remote_url` and its repository identity, its `HEAD` (`Git.head`), the caller as `parent` and the
main agent as `reportTo`; `Spawn` answers the address `<name>/<id>`, as every forwarded method does. With no main agent there is no `report_to`, as in `hc run --on`
with no parent: nothing is sent back, the result stays on B and `vibest result <name>/<id>` reads it there.
`--env`, `--peer`, `--archive-on-completion`, `--agent` and `--session` are refused with it, by vibestd, after the
reserved-name check every run gets. A stores nothing for the session.
The caller's environment (`callerEnv`) is not forwarded: it names the caller's terminal on A (a pane id, a socket
path), which means nothing on B. A sends a runtime kind instead. With `--runtime` it is that one; without it, the
runtime of the caller's terminal when the caller runs in one, else the runtime of A's main agent. B starts the session
in that runtime and fails with `NoRuntime` (`<B>: the runtime "x" is not
loaded; loaded: …`) when it does not have it. With none of the three, B's own hooks choose, as for a local run.
An address `<name>/<id>` is resolved once, at the entry of each method, into a local id or a machine and an id; a
bare id is always local and nothing is searched across machines. `vibest result|send|interrupt|archive|peek
<name>/<id>` forward `Get`, `Send`, `Interrupt`, `Remove` and `Peek` with `vibest-peer-project` set to the caller's
project. `List` (and `vibest ls`) answers `{ sessions, machines }`, as `hc ls` does: `sessions` has the local rows and
each connected machine's rows (ids `<name>/<id>`, `machine` set), asked of all machines at once; `machines` lists every
added machine, connected or not, with `state`, `since` and, when it is not connected, `reason`; a connected
machine whose `List` fails is shown `unreachable` with that failure as its `reason`. The code is
`core/src/remote.ts` (forwarding, the merged List, the remote Spawn) and `core/src/machines.ts` (add, dial, the
connection and outbox receiving).

Errors follow hc. An error from B reaches A's caller unchanged, with B's type and message and no machine prefix
(`NoSuchSession`, `AmbiguousSession`, `PromptTooLarge`, `NoProject`, `NoCommit` and the rest the method declares).
A adds only its own line errors: `UnknownMachine` (`unknown machine "x"; machines: mb`), `MachineUnavailable` (`mb
is unreachable: <why>`, `still connecting to mb`, or `lost the line to mb during the call (…); it may have happened
there; check, then retry`) and `MachineIncompatible` (B speaks another protocol; run vibest update there). A call to
a machine that is not connected fails at once; nothing is queued. The 1 MiB prompt limit is B's: A sends the prompt
and passes `PromptTooLarge` through.

After `Peer.Hello`, A opens `Peer.Outbox`. For each item it runs one transaction (`Db.receivePeerItem`): the
recipient's project (none: logged and acknowledged); the dedupe key `inbox.queued` with `request = 'peer:<outbox
id>'` on the item's recipient or on where it is routed now (found: only acknowledged); otherwise a `notice` row with no sender, routed to the
recipient while it has not ended, else to the project's entry session, `pending` when that one is present, else
`dropped`, with content `<name>/<id8>: <text>` (and a pointer to `vibest result` when the item was cut). Then
`Peer.Ack`. A pipe that drops between the commit and the ack sends the item again at the next connect, and the key
finds it. One edge case is left: if the recipient ended and the project's entry session changed between the first
delivery and the redelivery, the key sits on the old entry, which is neither of the two looked at, so one more notice
is written. The outbox stream failing (the 10 s ping timeout of a held pipe, for one) counts as the connection going
down.

## Terminals on other machines

vibest's machine list is the source of truth, and a runtime that can show other machines' terminals mirrors it: it
gets B when vibest adds or reaches B, gets it back whenever vibest needs it and finds it gone, and loses it at
`vibest machine rm`. The transport stays vibest's own ssh pipe; the view is an extra on top of it.

- **What B tells A.** `Peer.Hello` answers `runtimes`: every runtime loaded on B with its `status`, `reason` and
  `link`, an opaque record from the runtime's optional `link()` member (hc: `{core: <B's hc core id>, session: <B's hc
  session, or "" when B's vibestd reached its core through HC_SOCKET>}`). A keeps the last list per machine in memory
  with its time.
- **The hooks.** `machine.connect` ("make sure your runtime has this machine") and `machine.remove` ("make sure it
  does not") carry `{name, target, vibestd, runtimes, notes}`. `connect` fires inside `Machine.Add` after the row is
  stored (its notes go into the answer), at every reconnect and every connect after vibestd starts, after each plugin
  commit of the runtime registry for every connected machine (only to the hooks scoped to a runtime that commit added or
  replaced, plus unscoped ones), and at the moment of use (below, only to the hooks scoped to that runtime, plus
  unscoped ones). `remove` fires in `Machine.Remove` after the row is
  deleted, with the last Hello's runtimes (none after a vibestd restart with B unreachable); its notes go into the
  answer. A hook never fails a command; its trouble is a note with a fix. Fires and uses for one machine run one at a
  time under a per-machine lock, and a hook may hold it up to its 30 s bound, so an `ls` can wait behind a reconnect's
  or a plugin load's `connect` for that machine. A plugin that registers only machine hooks (no runtime definition) and loads after the machines are connected
  gets no `connect` for them until the next reconnect, because only a runtime registry commit triggers the catch-up.
- **`ensure`: check and repair at the moment of use.** Before `List` and `Get` rewrite a remote row of runtime kind
  `k`, before `Peek` names the terminal, before `machine ls` shows "here", and before `run --machine` sends
  `Peer.Spawn` with runtime `k`, A asks its runtime of kind `k` with `locate` where B's terminals are. `missing` (the
  runtime has no machine with the link's id) fires `connect` for that runtime and asks again. Still missing: the
  note is kept for 30 s, during which `ls`, `Get`, `Peek` and `machine ls` show it without trying again; `run
  --machine` always tries, and still starts the agent, answering the note in `notes`. The pause starts when the
  repair gives up, so a hook that hangs to its 30 s bound is not run again by the next `ls`.
- **Which runtime B uses.** The forwarding rule of `run --machine` is unchanged by the view (A: remote sessions):
  `--runtime`, else the caller's terminal runtime, else A's main agent's, also when A's runtime of that kind has no
  `locate`. So when A runs in the herdr TUI or Rex and B does not have that runtime, `run --machine` fails with B's
  `NoRuntime`; pass `--runtime <kind B has>` to run it there (its rows then say they cannot be shown here). `ensure`
  runs before `Peer.Spawn` only when A's runtime of the forwarded kind has `locate`.
- **The address.** A remote row's `address` becomes A's view: found, `{machine: "local", id: <the terminal id A's
  runtime takes>}` (hc: `mb/t7@<A's socket>`); not found, `{machine: <name>, id: ""}` and `view` says why (the
  runtime's note, a failed repair, or `<name>'s <kind> terminals cannot be shown here; vibest peek <name>/<id> reads
  them` when A has no runtime of that kind with `locate`). `vibest peek` prints `terminal here: <address>` or `not
  shown here: <view>` on stderr. `Machine.Add` also answers that core note for each kind of B's that A cannot show.
- **`machine ls`** gives per machine the runtimes of its last Hello (`runtimes`, `runtimesAt`), each with `here:
  {visible, as?, note?}` from `ensure`, and the last hook notes per plugin with their time (`notes`).
- **Stepping in.** Keys typed into the terminal on A go through the runtime's own link (A's hc core, B's hc core) to
  the harness on B. B records the typed turn as any local one, and its result reaches A's main agent once as the
  `<name>/<id8>: …` notice through B's outbox.

The hc plugin (`runtime-herdr-core/src/machines.ts`) finds its mirror row by the link's core id under any name:
`connect` adds `{target, name, session}` (never `install`) when there is none, counts `already_added` as done, and
replaces a `name_taken` row only when it has the same target and session and is not `connected` (B's core id
changed); another row is the user's and gets a note. After an add it waits up to 10 s for the row to leave `connecting`. `remove` removes the rows
with the link's core id, or, when there is no link because the event has no runtimes (a vibestd restart with B
unreachable) or B's hc gave none, the one row with the event's target (several: a note); when B reported runtimes
without hc, nothing. `locate` reads
`machine.list` and then `terminal.list` with `vibest.runtime=hc`, keeping the addresses under that row's name whose
`vibest.session` is one of the sessions, with a note when one of them has no terminal there. After its core's
`Subscribed` it runs `connect` again for the machines it last heard of and still holds. Terminals of other machines in A's own event stream match no session and are
ignored.

The herdr plugin (`runtime-herdr/src/machines.ts`) uses herdr's saved SSH machines, which live on the client side
(`$XDG_STATE_HOME/herdr/client/endpoints.json`, read and written only through `herdr machine …`). B's `link` is
`{session, version}`: herdr's default session `default`, where B opens every agent another machine starts (open's
`remote`), and the version its server answers to `ping` (none when that session is not running). A's `locate` reads
`herdr machine list --json` and takes the profile whose target (without `ssh://`) and session equal the event's target
and the link's session, under any label: none is `missing`, a disabled one is a note with `herdr machine enable <id>`.
Each session comes with the terminal id B reported for it (`<B session>/<pane>/<agent>`), so `locate` answers
`<B terminal>@<label of the profile for that terminal's herdr session>` without reaching B; a terminal in a herdr
session A has no enabled profile for gets a note. A's herdr server never holds B's panes, so
such an id is only a place to look in the herdr sidebar: `parseTerminal` refuses an id with `@`, and every runtime
member called with one fails `not_found` ("a pane on <label>; vibest peek and send reach it through vibest"). There
is no `focus` onto a remote herdr pane; herdr has no way to switch a TUI to a machine from outside.
The plugin asks a herdr server over its socket API wherever that API has the answer (`ping` for the version). It runs
the herdr CLI only where the API has none: saved machines are a client-side catalog with no server method
(`herdr machine list`), naming the session behind a socket path is a client-side directory listing (`herdr session
list`, inside the pool), and a server that is not running has no socket to ask (`herdr server`, inside the pool).

Its mirror (`runtime-herdr/src/mirror.ts`) keeps that profile: `connect` runs `herdr machine add <target> --label
<name>/<session> --remote-session <session>` with stdin not a terminal, so herdr never installs, updates, restarts or
stops anything on B (it refuses instead, and its words become the note, with no command as the fix: the same add run by
hand in a terminal can offer to stop B's server and end B's agents). It adds nothing when the profile exists (a
disabled one gets the `enable` note and stays disabled: the user disabled it), when another profile holds the label (a
`rename` note), when B's herdr is older than 0.9.5 (no machine API forwarding; an `update` note), or when B has no
herdr link (a note: B's herdr is offline, or online with no session named). A's own herdr is not version-checked: an
old one fails `herdr machine list`, and that failure is the note. `connect` gives up with a note after 25 s, inside the
machine hook's 30 s bound. `remove` runs `herdr machine remove <id>` for the profile of the link's session, or with no
link the one with the event's target and session `vibest` (several: a note); removing a profile leaves B's sessions
running. There is no re-check on a herdr server restart: the catalog is a client state file that a restart keeps, and
`ensure` repairs at the next use.

herdr saves only a B session whose server is its own session leader (`getsid(0) == getpid()`, reported as
`detached_server_daemon` by `ping`). vibestd on B starts a missing session with `herdr server --session <s>` spawned
detached, which makes the server a session leader (`setsid`), so B's own sessions are saved, also after they restart
(E2E M7). A session started some other way, such as `herdr server` typed in a shell, is refused; B's `link` then
carries `detached: no` and the refusal note says to restart that session on B once no agent runs there.

Limits: a profile is found by target string and session, so B saved by the user under another ssh alias gets a second
profile; herdr has no server id, so a target that now reaches another herdr server goes unnoticed; `vibest ls` cannot
say whether herdr's link to B is up; B's `link` is read when A connects, so its version and `detached` are as of then;
and the catalog is global for the user on A, so the profile shows in every herdr session's TUI there.

Not covered yet: Rex `link`, `locate` and subscribers; herdr-app's panel focusing a remote row (its own PR);
replacing a mirror row when B's vibestd moved to another hc session on the same host.

## Optional tables

Created when missing at open (schema.md, Optional objects).

```sql
CREATE TABLE machine (             -- A: another machine's vibestd this one dials
  name         TEXT PRIMARY KEY,   -- what --machine takes; the first part of an address racknerd/<id>
  target       TEXT NOT NULL,      -- ssh target; never a password
  vibestd_id   TEXT NOT NULL UNIQUE CHECK (length(vibestd_id) = 36),  -- B's identity id at machine add; never changed
  connected_at INTEGER NOT NULL,   -- last successful connect (the add is the first)
  created_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE peer (                -- B: a vibestd that dials this one, like an hc peers.json entry
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),  -- that vibestd's identity id
  name         TEXT NOT NULL,      -- its identity name, as it last presented it
  calls_me     TEXT NOT NULL,      -- the machine name it uses for this vibestd, as it last presented it
  connected_at INTEGER NOT NULL    -- its last successful Peer.Hello
) STRICT;

CREATE TABLE outbox (              -- B: what this vibestd still has to deliver to a peer
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),  -- random UUIDv4; the dedupe key on A
  peer_id    TEXT NOT NULL REFERENCES peer (id),
  session_id TEXT NOT NULL REFERENCES session (id),  -- the peer session it is about
  kind       TEXT NOT NULL CHECK (kind IN ('result', 'notice')),
  content    TEXT NOT NULL,        -- rendered on B
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX outbox_peer ON outbox (peer_id, created_at);
CREATE INDEX outbox_session ON outbox (session_id);
```

A row exists until A acknowledges it; there is no status column.
