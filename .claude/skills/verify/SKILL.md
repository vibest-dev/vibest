---
name: verify
description: Build/launch/drive recipe for verifying vibest web changes at runtime (tsx dev server, dynamic port)
---

# Verifying vibest at runtime

## Build + launch

```bash
# Start the dev server (run_in_background) — no prebuild needed:
# @vibest/harness exports src/*.ts directly and tsx resolves it.
# Pin the port so the URL is deterministic (dev otherwise picks a random one):
cd packages/vibest && VIBEST_PORT=4000 pnpm dev
```

This runs `NODE_ENV=development tsx src/node/cli.ts`: one server bound to
`127.0.0.1` with Vite middleware serving **`apps/app`**, oRPC at `/api/rpc`, WS
at `/ws/rpc`, health at `/api/health`.

**Port is dynamic in dev.** `readPort()` returns `0` under `NODE_ENV=development`
(the OS assigns an ephemeral port) unless `VIBEST_PORT` is set. Either pin it
with `VIBEST_PORT=4000` (recommended), or read the actual port from the dev
output — the server prints `vibest:ready {"port":<PORT>}` then
`vibest listening on http://127.0.0.1:<PORT>`. Health check:
`curl http://127.0.0.1:<PORT>/api/health` → `ok`.

Gotchas:

- Toolchain is pnpm + Turborepo: `pnpm run check` = oxlint + oxfmt + turbo
  typecheck; `pnpm run format` to fix formatting. Typecheck one package with
  `turbo run typecheck --filter=@vibest/app`.
- **TanStack Router's `routeTree.gen.ts` regenerates only when the Vite router
  plugin runs** — on app load through the dev server, NOT on typecheck. After
  adding/renaming/deleting route files, hit the app root once
  (`curl -o /dev/null http://127.0.0.1:<PORT>/`) before typechecking, or
  typecheck fails against the stale tree.

## Flows worth driving

- `/` redirects to `/draft` (the new-session surface: a centered composer with a
  model select; send disabled while empty).
- On `/draft`: type a prompt → send → creates a session, sends the prompt, and
  navigates to `/session/<uuid>` with the user bubble already shown and the
  assistant reply streaming in.
- Model select in the composer toolbar (Opus/Sonnet).
- `/session/<uuid>` is just transcript + composer (no header bar).

## Browser automation (agent-browser)

`agent-browser` (bun-global, 0.15.x) drives Chromium via CDP with
accessibility-tree snapshots: `agent-browser open <url>` / `snapshot` /
`click @eN` / `keyboard type <text>` / `get url`.

- It needs playwright's **chromium-headless-shell build 1208** (bundles
  playwright-core ^1.57.0). `agent-browser install` fails
  (`playwright: command not found`) — install with
  `node ~/.bun/install/global/node_modules/playwright-core/cli.js install chromium-headless-shell`.
  The download is slow (~200MB); as a stopgap a symlink
  `chromium_headless_shell-1208 -> -1228` under `~/Library/Caches/ms-playwright/`
  launches fine.
- CDP-synthesized Enter/`\n` does NOT trigger the composer's submit path — click
  the send button element instead. Shift+Enter probing works (content stays put).
