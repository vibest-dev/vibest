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
id: A refuses dialing itself).

`vibest connect`, `vibest machine` and `vibest peer` are the user's: `userOnly` refuses them for agents, and the
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
`remote_url` equals `repository` (a multi-repository project is refused), checks that the checkout has `commit`
(`Git.hasCommit`: `git cat-file -e <sha>^{commit}`; "<B>'s checkout <dir> does not have <sha>: push it
and fetch it there"), and runs `Sessions.spawn` with the worktree detached at that commit. B learns a checkout with
`vibest project add [dir]` (user only). The session is an ordinary B session with no parent and no report-to; who
started it is one `peer.start` event (peer, project, parent?, reportTo?), written in the transaction that creates
the session row; it has no `report_to` when A's project had no main agent. The forwarded `request` finds the session on a retry.

Every result and notice of a peer session with a `report_to` goes to B's `outbox` in the transaction that writes it. B still writes the
inbox row, addressed to the session itself and `dropped`, so `vibest result` on B and a forwarded `Get` read it, and
B's own delivery never sees it. With no `peer` row (after `vibest peer rm`) nothing is queued. `Peer.Outbox` streams
the peer's rows in `created_at` order (insertion order on a tie), then each new one after its commit; an item over
1 MiB is sent cut with `cut: true`. `Peer.Ack { ids }` deletes them. Archiving a peer session deletes its rows, and
`vibest peer rm` deletes the peer row and its outbox in one transaction and ends its open streams.

`List`, `Get`, `Send`, `Interrupt`, `Remove` and `Peek` from a peer resolve a session id only among sessions whose
`peer.start` has that peer and that project; any other session is `NoSuchSession`. `vibest peer ls` shows each peer
with whether a stream is open now, its undelivered rows and its open sessions.

## A: remote sessions

`vibest run --machine <name>` (the user or the main agent) sends `Peer.Spawn` over the machine's connection with
the project's one repository's `remote_url`, its `HEAD` (`Git.head`), the caller as `parent` and the
main agent as `reportTo`; `Spawn` answers the address `<name>/<id>`, as every forwarded method does. With no main agent there is no `report_to`, as in `hc run --on`
with no parent: nothing is sent back, the result stays on B and `vibest result <name>/<id>` reads it there.
`--env`, `--peer`, `--archive-on-completion`, `--agent` and `--session` are refused with it, by vibestd, after the
reserved-name check every run gets. A stores nothing for the session.
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
id>'` anywhere in that project (found: only acknowledged); otherwise a `notice` row with no sender, routed to the
recipient while it has not ended, else to the project's entry session, `pending` when that one is present, else
`dropped`, with content `<name>/<id8>: <text>` (and a pointer to `vibest result` when the item was cut). Then
`Peer.Ack`. A pipe that drops between the commit and the ack sends the item again at the next connect, and the key
finds it. The outbox stream failing (the 10 s ping timeout of a held pipe, for one) counts as the connection going
down.

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
