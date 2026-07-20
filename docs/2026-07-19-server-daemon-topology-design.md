# Server topology: every vibest server is a discoverable single-instance daemon

How a `vibest` server should be launched and reached — locally by the desktop app
and the `vibest` CLI, and remotely by other machines. This is about **server
lifecycle and connection topology**.

It sits between two existing designs and should be read with them:

- [`2026-07-14-desktop-embedding-comparison.md`](./2026-07-14-desktop-embedding-comparison.md) — how the UI gets into the Electron window (out of scope here).
- [`2026-07-19-remote-ssh-server-design.md`](./2026-07-19-remote-ssh-server-design.md) — the **SSH-tunnel remote model** (v1 implemented on branch `t3code/multi-server-ssh`). This document defers to it for everything "remote" and only unifies the _local_ launch path with it.

## The problem (local plane)

Today "the server started by desktop" and "the server started by `vibest` CLI"
_look_ like the same thing because they share code, but they are two independent
instances with different configs and no coordination:

- **The runnable server lives in the wrong package.** `@vibest/server` is only a
  domain/RPC library; the thing that binds a port — `createServer`, `listen`,
  auth, CORS, tickets, static serving — lives in `@vibest/cli`
  (`packages/vibest/src/node/server.ts`). `apps/desktop` therefore depends on
  `@vibest/cli`, forks its `dist/cli.mjs`, and imports its private
  `@vibest/cli/handshake` protocol. The arrow points GUI → CLI, backwards.

- **Shared-state split-brain (a real correctness bug).** Both instances read and
  write the same `$VIBEST_HOME` (`~/.vibest`): `sessions/`, `projects.json`,
  `config.json` (`packages/server/src/config/paths.ts`). A desktop instance
  (ephemeral port) and a CLI instance (`:4000`) running at once mutate those files
  concurrently with no lock → lost writes, inconsistent session lists.

- **Two philosophies bolted together.** CLI = fixed `:4000`, no `EADDRINUSE`
  fallback, **no auth**. Desktop = ephemeral port, per-launch token, WS ticket,
  supervisor. No single coherent model.

## The key realization: the remote plane already got this right

The SSH-remote design (already landing) treats a remote `vibest serve` as a
**single-instance daemon discovered through files**:
`~/.vibest/ssh-launch/<stateKey>/` holds `pid`, `port`, and `token`, and the
launch script _reuses_ a healthy running server instead of starting a second one.
The client reaches it purely over `ssh -L` and only ever talks to `127.0.0.1`.
"Internet from anywhere" is already solved there by **SSH + Tailscale** (a tailnet
MagicDNS host is just an ordinary SSH host) — no relay, no inbound ports, leaning
entirely on the user's existing SSH trust.

So the topology principle is not new — it is **already implemented remotely** and
merely missing locally:

> **Every vibest server — local or remote — is a single-instance daemon per
> `$VIBEST_HOME`, discovered through a file, and attached-to rather than
> re-spawned.** "Reach" is a separate concern layered on top: loopback for local,
> `ssh -L` for remote.

The local plane is the one that's behind. This design brings desktop and CLI up to
the discipline the remote path already has, and unifies the launch seam so
"spawn a local daemon", "reuse a running local daemon", and "launch-and-tunnel a
remote server" are the same shape.

## Design

```
                         one oRPC/WS handler + harness runtime per server
                         ┌───────────────────────────────────────────┐
                         │            @vibest/server (daemon)          │
   local reach           │  single-instance lock on $VIBEST_HOME       │   remote reach
 127.0.0.1:<port> ─────▶ │  writes discovery file (pid/addr/token)     │ ◀───── ssh -L
   discovery: daemon.pid│  auth token + CORS + WS ticket (existing)   │        (existing
                         └───────────────────────────────────────────┘         SSH design)
        ▲            ▲                                                       ▲
   apps/desktop   @vibest/cli                                          another machine's
   (attach-or-    (attach-or-spawn                                     `vibest serve`,
    spawn)         + `vibest daemon …` + `vibest remote …`)            reused via ssh-launch
```

### Module boundaries (fixes the inversion)

- **`@vibest/server`** — the whole server. Keeps domain/RPC; gains the HTTP/WS
  transport moved out of `@vibest/cli` (`./http` subpath), plus the lifecycle
  (single-instance lock + `daemon.pid` discovery). Builds a forkable
  `dist/server.mjs`. This is the "core" the recorded target architecture wants.
- **`@vibest/cli`** — a thin bin over `@vibest/server/http`: `vibest serve`
  (unchanged entry — the SSH remote runner installs `@vibest/cli@<version>` from
  npm and runs `serve`, so this must keep working and stay self-contained; the
  current tsdown bundle already inlines `@vibest/server`, keep that), plus
  `vibest daemon {start,stop,status}` and the existing `vibest remote …`.
- **`apps/desktop`** — an attach-or-spawn client with its supervisor. Drops the
  `@vibest/cli` dependency; depends on `@vibest/server`. `parseReadyLine` moves to
  `@vibest/server/http`.
- **`@vibest/client`** — the shared transport, unchanged; every client (desktop,
  CLI, remote-over-tunnel) already goes through it.

Result: a clean fan-out from `@vibest/server`. No client → client edges. The
desktop `SpawnServer` / `RunningServerProcess` interface becomes the single seam
the SSH design already pointed at, so a remote "launch + tunnel" can later present
as just another `RunningServerProcess` to the same supervisor.

### Discovery and single-instance (local plane)

The daemon binds `127.0.0.1:<port>` and atomically writes `$VIBEST_HOME/daemon.pid`
(`0600`) — the local mirror of the remote `ssh-launch/<stateKey>/{pid,port,token}`:

```jsonc
{ "pid": 12345, "address": "http://127.0.0.1:41234", "token": "…", "startedAt": … }
```

It holds a single-instance lock keyed on `$VIBEST_HOME`. Every local front-door
runs the same `resolveOrSpawnServer()`:

1. Read `daemon.pid` → health-check `address`.
2. Alive → **attach** (use its `address` + `token`).
3. Absent/dead → **spawn** `@vibest/server`'s `dist/server.mjs`, wait for ready,
   attach.

This removes the split-brain (one instance), the layering inversion (server in
`@vibest/server`), and the `:4000` collision crash (port comes from the file;
default may stay `:4000` with a `→ :0` fallback). Keep the existing stdout
`vibest:ready {port}` handshake and add opencode's **two-signal readiness**
(handshake _and_ an HTTP health poll), per the embedding comparison.

**"Daemon" is a startup method, not a property of the server.** The server stays a
plain foreground process — it binds a port, serves, prints `vibest:ready {port}`,
and is entirely daemon-unaware: it does **not** self-detach, and does **not** write
or hold `daemon.pid` / a pid / a lock. Daemonization lives one layer up, in a
**launcher** shared by the CLI and desktop. This mirrors the SSH remote design
exactly: there, `vibest serve` is a dumb foreground process and the _launch script_
owns `nohup`, the captured pid, reading the port from the log, and the
`pid/port/token` reuse files. The local daemon is that same launcher, run locally
instead of over SSH.

- **Launcher (`resolveOrSpawnDaemon`, shared by CLI + desktop).** Read `daemon.pid`
  → pid alive + health-check → **attach**; else spawn `serve` **detached**, read the
  port from the handshake line, write `daemon.pid` (pid/addr/token). `daemon.pid`
  _is_ the single-instance marker (staleness = "is the pid alive"); the server never
  touches it. Lock, discovery, reuse, and backgrounding all live here — the local
  twin of the SSH launch script. This resolves the earlier "lifetime knob" toward
  _resident_: a short-lived `vibest` command must operate a backend that outlives it.
- **Foreground `serve` needs no special mode.** Because the server is plain, the same
  process works unchanged for the launcher (spawned detached), for process managers
  and containers (systemd, Docker), for the SSH remote runner
  (`nohup vibest serve`), and for debugging. Interactive local use just never runs it
  directly — the launcher does.
- **Desktop must attach the same daemon**, not spawn a die-with-app child, or the
  `$VIBEST_HOME` split-brain returns the moment the CLI is used alongside it.
  Consequence: **the local server survives quitting the desktop app** (agents keep
  running) — consistent with the remote/CLI semantics, but a behavior change from
  today's managed child.
- **Shutdown policy (open).** A resident daemon needs a stop rule. Options: explicit
  only (`vibest daemon stop`); idle-timeout guarded by active agent sessions
  (recommended — reclaim only when truly unused); or last-client-refcount (rejected —
  would kill background agents). Pick when Phase 4 lands; not needed earlier.

### Authentication

The existing `VIBEST_AUTH_TOKEN` → HTTP Bearer → WS-ticket chain stays as the
mechanism. Two changes, both forced by SSH-less browser reach (below):

- **Local token comes from the `0600` `daemon.pid`**, so same-user local
  front-doors read it automatically. The same-origin browser the daemon serves
  locally reads its token from a same-origin `/api/bootstrap` endpoint (no
  cross-origin, no leak). Desktop keeps its cross-origin + WS-ticket path; remote
  over SSH keeps the tunnel + ticket path from the SSH design.
- **The unauthenticated "browser mode" is removed.** Today, an unset
  `VIBEST_AUTH_TOKEN` disables `/api/*` auth and the WS ticket
  (`packages/vibest/src/node/server.ts:100`). Once a plain browser can reach the
  server over a public URL, that default is a remote-code-execution hole (the
  server can spawn shells). **Every non-loopback client must authenticate.** The
  daemon always has a token; loopback same-user gets it from the file, and a
  remote browser gets a **scoped, revocable session token via pairing**, never the
  daemon's own token.

### Remote reach: defer to the SSH design

Remote is **already designed and landing** as SSH tunnels + multi-environment
coexistence (see the SSH design doc). Nothing in this document competes with it:

- The client always talks to `127.0.0.1` (tunnel entrance). No inbound ports.
- Internet-from-anywhere is SSH + Tailscale, not a relay.
- The remote server is the _same_ `vibest serve`, already single-instance via its
  `ssh-launch` files — i.e. the daemon principle above, remote.

This design's only obligation to the remote plane is to keep `vibest serve`
self-contained and to make the local launch seam (`SpawnServer`) general enough to
absorb "launch + tunnel" later.

## Future-compatibility: SSH-less browser (not built here)

A **plain browser** (a phone, or anyone without SSH access to the dev box) cannot
run `ssh -L`, so it will eventually need its own path — either a tunnel the user
controls (Tailscale Funnel / Cloudflare Tunnel / ngrok) or a vibest-hosted relay,
plus pairing-based auth and, for an untrusted relay, E2EE. **None of that is built
or decided here.** The only obligation on _this_ design is to not paint that future
into a corner. It doesn't, provided the current work honors these invariants:

- **Authenticate by token, not by origin or by "it came from loopback."** The
  server must treat a valid credential as the gate, independent of where the
  connection originated. It already half-does this: the WS ticket is decoupled from
  headers, and `@vibest/client` is URL-parameterized (the multi-environment work
  already runs N connections to N base URLs). Keep it that way; do not let CORS
  allowlist or a loopback check _become_ the auth gate. A tunnel/relay socket must
  be indistinguishable to the handler from a local one — the same "authenticate the
  token" path, à la paseo's single handler for direct and relay sockets.
- **Never make an unauthenticated path load-bearing.** Today an unset
  `VIBEST_AUTH_TOKEN` disables auth entirely (`packages/vibest/src/node/server.ts:100`).
  If that "browser mode" stays a default that any remote path could reuse, enabling
  SSH-less browser later is a breaking change _and_ a security cliff. So Phase 3
  builds auth as a **credential set with pluggable sources** (today: the
  `daemon.pid` file source), not a single hardcoded secret — adding a
  paired-session-token source later is then purely additive. Any no-auth mode
  survives only as an explicit loopback-only escape hatch, never the remote default.
- **Loopback-only bind is fine and stays.** Both future NAT strategies are
  compatible with it: a tunnel forwards to a local port, and a hosted relay has the
  daemon dial _outbound_ — neither needs the daemon to bind a public interface.
- **Keep the discovery record extensible.** `daemon.pid` is plain JSON; a future
  relay's `serverId`/keypair are new fields, not a schema break. Don't need them now.

Net: the daemon + discovery + token-set auth substrate this design builds is the
same substrate a relay/pairing plane later sits on. SSH-less browser is an
_additional plane_, added when wanted, with no rework of the current work.

## Why not the alternatives

- **"Server stays a library each launcher embeds" (per-launch instance).** Needs a
  lock anyway to avoid the `$VIBEST_HOME` split-brain, and diverges from the remote
  path which is already daemon-shaped. The unified daemon is strictly more coherent.
- **"Bound-to-spawner daemon" (dies with its spawner).** Fine for pure local, but
  the remote path already keeps servers alive independently of any one client;
  matching that (resident, reuse-on-attach) keeps local and remote consistent.
- **A relay for remote.** Redundant with SSH + Tailscale for SSH-capable clients.
  It (or a user-controlled tunnel) is the future path for the SSH-less browser case,
  but that is an additional plane built later — not part of this design.

## Phased plan

1. **✅ Landed — Extract the plain server into `@vibest/server`.** Move
   `server.ts / auth / cors / listen / handshake` from `@vibest/cli` into
   `@vibest/server` (`./http`); add a tsdown build producing `dist/server.mjs`. This
   stays a daemon-unaware foreground server (bind, serve, print the ready line). Keep
   `@vibest/cli` a thin, self-contained bin (`serve` still bundles `@vibest/server`
   so the npm-installed remote runner keeps working). `apps/desktop` forks the
   `@vibest/server` artifact and imports `parseReadyLine` from `@vibest/server/handshake`;
   drop the `@vibest/cli` dependency. **Touches build outputs and the
   electron-builder asar path — needs a packaged-build check.**
2. **✅ Landed (CLI) — Add the daemon launcher (a layer above the server, not inside
   it).** A shared `resolveOrSpawnDaemon` (`@vibest/server/daemon`) that reads/writes
   `$VIBEST_HOME/daemon.pid`, does the pid-alive + health-check reuse, spawns the
   foreground server detached (streamed to `daemon.log`), and applies two-signal
   readiness (pid alive + `/api/health`) and the `:4000 → :0` fallback. The local twin
   of the SSH launch script; the server itself is untouched. The daemon process is
   `vibest serve` re-launched from this same CLI argv — no second bundle. Bare `vibest`
   and `vibest daemon {start,stop,status}` are the front-doors; brought forward from
   Phase 4. **Desktop attaches this same daemon too**: the supervisor's `SpawnServer`
   is now daemon-backed (`makeDaemonServerProcess`) — attach-or-spawn through the
   shared launcher, exit detected by polling pid + health (a dead daemon is
   re-spawned by the supervisor loop), and the renderer connection always serves the
   latest port/token since a daemon respawn mints fresh ones. CORS needs no
   convergence: the daemon's origin policy is **static** (the desktop scheme +
   loopback are always trusted; extra origins ride ambient `VIBEST_CORS_ORIGINS`),
   so any client attaches to the one daemon regardless of who started it — the
   old record-origins-and-restart-with-the-union dance is gone. Defense-in-depth
   beyond CORS (which does not guard WebSockets): the WS upgrade repeats the
   origin check, and every request is refused unless its Host is loopback
   (anti DNS-rebinding). Consequence, as designed: **the daemon survives quitting
   the desktop app.**
   The launcher is Effect-based orchestration (typed `DaemonLaunchError` /
   `DaemonStoppedError` in the error channel, `Effect.sleep`/`Clock` polling,
   interruption-safe lock release via `ensuring`) around one deliberately-raw
   seam: the detached, unref'd, log-fd spawn itself, which is the opposite of
   the supervised-child model `effect/unstable/process` provides and so stays
   plain `node:child_process`.
   Post-review hardening: spawns are serialized by an exclusive-create
   `daemon.lock` (loser attaches to the winner), a wedged daemon (pid alive,
   health failing) is killed before its replacement spawns, health probes are
   hard-bounded (1s) so a wedged daemon cannot hang liveness, and `stopDaemon`
   leaves a `daemon.stopped` tombstone that auto-respawn honors
   (`DaemonStoppedError`) while explicit starts clear it. The renderer re-fetches
   its connection on every ready transition, since a respawned daemon mints a
   fresh token.

   **Open issue — first-spawner environment/runtime freeze.** The daemon inherits
   the environment (and executable: Electron-as-node vs node) of whichever client
   spawned it first; attaching clients never converge it. A
   CLI-spawned daemon from an env-poor shell bypasses the desktop's login-shell
   resolution (proxy vars — the known silent-hang failure mode), and a
   desktop-spawned daemon runs under the app bundle's binary, which an app
   update/uninstall invalidates. Candidate fix for Phase 3/4: record an env
   fingerprint in `daemon.pid` and converge like CORS, and prefer one canonical
   runtime (system node when present) regardless of the spawning front-door.

3. **Unified auth (built as a credential set, not a single secret).** Local token
   flows through `daemon.pid` + a same-origin `/api/bootstrap`. Model the gate as a
   set of credential sources with one member today (the file source); demote any
   no-auth mode to an explicit loopback-only escape hatch. This is the single place
   the current work must be shaped for the SSH-less future — a paired-session-token
   source then slots in additively.
4. **Unify the launch seam.** Fold "launch + tunnel" (from the SSH design) into the
   desktop `SpawnServer` / `RunningServerProcess` supervisor so local and remote
   servers are supervised identically. Add `vibest daemon {start,stop,status}` and
   the shutdown policy (idle-timeout guarded by active sessions, recommended above).

**Out of scope (future, additive):** the SSH-less browser plane — a
tunnel/relay + pairing + optional E2EE — built only when wanted, on top of the
credential-set auth and extensible discovery record above, with no rework of
Phases 1–4.

## References

- [`2026-07-19-remote-ssh-server-design.md`](./2026-07-19-remote-ssh-server-design.md) — the authoritative remote model this design defers to.
- [`2026-07-14-desktop-embedding-comparison.md`](./2026-07-14-desktop-embedding-comparison.md) — UI-into-window; port/readiness/auth per project.
- Prior art read from source: opencode (`packages/server` + `lildax` split,
  `utilityProcess` sidecar), paseo (`@getpaseo/server` resident daemon,
  `~/.paseo/paseo.pid` discovery, outbound relay + E2EE pairing — the SSH-less model).
