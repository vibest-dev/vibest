# Package layout and boundaries

`contract ← server ← cli|desktop` and `contract ← client ← app ← desktop`.

| dir                 | name                         | role                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contract` | `@vibest/contract`           | oRPC contract + Effect `Schema` domain types — the shared wire vocabulary. Also the browser-safe agent UI surface: `@vibest/contract/{claude-code,codex}` tool schemas + UI-message types and `codex/protocol` (ts-rs types). Leaf; nothing may point back at it. |
| `packages/server`   | `@vibest/server`             | All runtime: domain services, session runtime, harness transforms + adapters, oRPC router, HTTP/WS, daemon.                                                                                                                                                       |
| `packages/client`   | `@vibest/client`             | ~60-LOC factory for a typed oRPC WebSocket client.                                                                                                                                                                                                                |
| `packages/ui`       | `@vibest/ui`                 | React components. Subpath-only exports, no barrel.                                                                                                                                                                                                                |
| `apps/app`          | `@vibest/app`                | The SPA — **also a library**: Desktop mounts `PlatformProvider` + `AppInterface` from the root export only.                                                                                                                                                       |
| `apps/desktop`      | `desktop` (unscoped)         | Electron shell supervising a forked server over MessagePort oRPC.                                                                                                                                                                                                 |
| `packages/vibest`   | `@vibest/cli` (bin `vibest`) | Thin CLI over `@vibest/server/{daemon,http}`.                                                                                                                                                                                                                     |

## Boundaries

- **`packages/server/src/harness/<agent>/` holds each agent's whole Node side** —
  pure transforms (`transform.ts`, `to-session-event.ts`, `request.ts`, …)
  alongside the process/SDK drivers (`agent.ts`, `adapter.ts`, `transport.ts`).
  The browser-shared half of each agent — tool schemas + UI-message types — lives
  in `packages/contract/src/<agent>/` because the SPA renders against it; keep
  those pure and diskless.
- **The session domain lives in `packages/server/src/harness/` with exactly five
  public roles**: `HarnessAgentRegistry` (who exists), `HarnessAgentAdapter` (how
  to get in), `HarnessAgentSessionManager` (sole owner of live state — one
  session per ref; the only caller of `adapter.open`/`adapter.resume`),
  `HarnessAgentRuntime` (the live execution resource an adapter produces: a pi
  child, a Claude SDK handle, a Codex thread), and `HarnessAgentSessionService`
  (the outward face: SessionRef ↔ native-id translation, metadata persistence,
  wire-vocabulary validation, collection events). `session.ts`,
  `session-fold.ts` and `session-repository.ts` are private collaborators of the
  manager and the service — no Context tags, don't wire them directly.
  `HarnessAgentSession` (`session.ts`) is one session as this server sees it —
  the owner of phase, seq/cursor, buffers and pending requests — and it
  _optionally_ owns a runtime: observing a session costs no process, and a
  runtime is acquired only by a prompt (or by a history read on a harness with
  no cold `adapter.getMessages`). The RPC router contributes only
  `projectId → workspace path`
  (via `ProjectService`) and error-code mapping. Adapters see `cwd`, never
  `projectId`; the manager receives a `SessionRef` but only carries it (event
  stamping), never interprets it.
- `EventBusLayer` must stay a single Layer reference across publish and
  subscribe wiring — Effect memoizes layers by reference, and a second
  reference (or `Layer.fresh`) silently splits the bus.
- `packages/contract/src/codex/protocol/**` is ts-rs–generated (`codex
app-server generate-ts`) and is in the lint/format ignore lists. Don't hand-edit.
- `packages/ui/src/components/*` is vendored from the coss registry and refreshed
  with `--overwrite`, so edits there get discarded. Fix in the `ai-elements/` or
  `claude-code/` wrappers, or upstream (`docs/adr/0001`). `carousel` and
  `splitter` are the local exceptions.
- `apps/desktop/AGENTS.md` holds that app's own layering contract (allowed and
  forbidden imports per directory, single composition root, `ipcRenderer` only in
  `src/preload/`). Read it before touching `apps/desktop/src`.
- Port binding, auth, CORS, ticketing, static serving → `packages/server/src/http`,
  not the CLI. `packages/server/src/config/paths.ts` is the only place that names
  persistent roots: `resolveVibestHome` for Projects and Sessions,
  `resolveDaemonDirectory` for lifecycle state, and `logsDirectory` for
  `$VIBEST_HOME/logs`. The daemon directory holds only `daemon.pid`, `.lock`, and
  `.stopped`. `Paths` includes `logsDir`; directory `0700` and files `0600` are
  part of that contract (`LOGS_DIRECTORY_MODE` / `LOG_FILE_MODE` in `paths.ts`).
  The process-owned observability Layer appends to `logsDir/vibest.log` and
  requires FileSystem, Crypto, and Paths — bound at `runServe` / `NodeServices.layer`.
  Do not seal a platform layer inside the observability module, and do not name
  the log directory a second time. The RPC `ManagedRuntime` must `provideMerge`
  the process context captured after that provide; `mergeAll` leaves fibers forked
  during `AgentRuntimeLayer` construction on Effect's default logger. Tests that
  do not write a log file provide `Observability.discard` so `Effect.log*` does
  not leak to stdout. The single-daemon invariant is keyed on the daemon
  directory, so every front door resolves it there and passes it down —
  `packages/server/src/daemon/paths.ts` names files inside a directory it is
  handed and deliberately has no default of its own.
- `HarnessAgentIdSchema` in `packages/contract/src/domain.ts` is the whitelist:
  `claude-code`, `codex`, `pi` and nothing else. A fourth harness needs a literal
  there, a `packages/server/src/harness/<agent>/` transform, and its adapter added
  to the `RegistryLayer` in `packages/server/src/rpc/runtime.ts` — all three, or it
  is unreachable at runtime. `harness/registry.ts` is only the lookup table's
  factory (`makeHarnessAgentRegistry(adapters)`) and names no harness; that
  composition root is the single place the adapters are constructed, and it wraps
  each in `cacheAvailability` so a `--version` probe costs one spawn per server
  rather than one per call.
