# Package layout and boundaries

`contract ← harness ← server ← cli|desktop` and `contract ← client ← app ← desktop`.

| dir                 | name                         | role                                                                                                                |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/contract` | `@vibest/contract`           | oRPC contract + Effect `Schema` domain types — the only shared wire vocabulary. Leaf; nothing may point back at it. |
| `packages/harness`  | `@vibest/harness`            | **Pure** agent-protocol conversion. Browser-safe, stateless, diskless — no runtime.                                 |
| `packages/server`   | `@vibest/server`             | All runtime: domain services, session runtime, harness adapters, oRPC router, HTTP/WS, daemon.                      |
| `packages/client`   | `@vibest/client`             | ~60-LOC factory for a typed oRPC WebSocket client.                                                                  |
| `packages/ui`       | `@vibest/ui`                 | React components. Subpath-only exports, no barrel.                                                                  |
| `apps/app`          | `@vibest/app`                | The SPA — **also a library**: Desktop mounts `PlatformProvider` + `AppInterface` from the root export only.         |
| `apps/desktop`      | `desktop` (unscoped)         | Electron shell supervising a forked server over MessagePort oRPC.                                                   |
| `packages/vibest`   | `@vibest/cli` (bin `vibest`) | Thin CLI over `@vibest/server/{daemon,http}`.                                                                       |
| `packages/services` | `@vibest/services`           | Dormant, zero consumers. Live git code is `packages/server/src/git/service.ts`.                                     |

## Boundaries

- **harness and server both have `claude-code/`, `codex/`, `pi/` directories.**
  Transforms live in `packages/harness/src/<agent>/`; the Node-side process and
  SDK drivers live in `packages/server/src/harness/<agent>/`. Easy to edit the
  wrong one.
- `packages/server/src/session/port.ts` is the single seam onto a HarnessAgent —
  `SessionService` never imports `@vibest/harness` directly. Adapters see `cwd`,
  never `projectId`; resolving one to the other is `ProjectService`'s job.
- `packages/harness/src/codex/protocol/**` is ts-rs–generated (`codex
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
  there, a `packages/harness/src/<agent>/` transform, and a server adapter
  registered in `packages/server/src/harness/registry.ts` — all three, or it is
  unreachable at runtime.
