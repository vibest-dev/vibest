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
- `packages/server/src/session/port.ts` is the single seam onto a HarnessAgent —
  `SessionService` talks only to this port, never to the harness adapters
  directly. Adapters see `cwd`, never `projectId`; resolving one to the other is
  `ProjectService`'s job.
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
  not the CLI. `resolveVibestHome` in `packages/server/src/config/paths.ts` is the
  only definition of `$VIBEST_HOME`; the one-daemon-per-home invariant rests on it.
- `HarnessAgentIdSchema` in `packages/contract/src/domain.ts` is the whitelist:
  `claude-code`, `codex`, `pi` and nothing else. A fourth harness needs a literal
  there, a `packages/server/src/harness/<agent>/` transform, and a server adapter
  registered in `packages/server/src/harness/registry.ts` — all three, or it is
  unreachable at runtime.
