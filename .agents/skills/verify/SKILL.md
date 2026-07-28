---
name: verify
description: Build/launch/drive recipe for verifying vibest web changes at runtime (two processes: vite dev + the server)
---

# Verifying vibest at runtime

## Build + launch

Dev is **two processes**: Vite serves the app, the vibest server serves the API,
and Vite proxies `/api` + `/ws/rpc` across so the browser stays same-origin.

```bash
# The API server (run_in_background) — no prebuild needed:
# workspace packages export src/*.ts directly and tsx resolves them.
cd packages/vibest && pnpm dev            # foreground `serve` on VIBEST_PORT=4180

# The app (run_in_background), in a second call:
cd apps/app && pnpm dev                   # vite on 4190 (strict), proxying to 4180
```

Open **the Vite URL** (`http://localhost:4190/`), not the server port — 4180
answers `/api/*`, `/ws/rpc`, and the _built_ bundle, so it either 503s ("not
built") or quietly serves a stale build instead of your edits. `pnpm dev` at the
root runs both through turbo.

Health check: `curl http://127.0.0.1:4180/api/health` → `ok`, and
`curl http://localhost:4190/api/health` → `ok` proves the proxy.

To move the API off 4180, export `VIBEST_PORT` for **both** processes —
`vite.config.ts` reads the same variable to pick its proxy target. Don't point
it at **4000**: that is the daemon's port, which the desktop app spawns and
guards with an auth token, so the app would load and then fail to connect
(`/api/health` 200, `/api/ws-ticket` 401) instead of failing loudly. If the app
loads but shows no data, check which process owns the proxy target first:
`lsof -nP -iTCP:4180 -sTCP:LISTEN`.

Restarting the server no longer reloads the browser: Vite keeps the page, the
client reconnects over the proxied WS.

Gotchas:

- Toolchain is pnpm + Turborepo: `pnpm run check` = oxlint + oxfmt + turbo
  typecheck; `pnpm run format` to fix formatting. Typecheck one package with
  `turbo run typecheck --filter=@vibest/app`.
- **TanStack Router's `routeTree.gen.ts` regenerates only when the Vite router
  plugin runs** — on app load through the Vite dev server, NOT on typecheck.
  After adding/renaming/deleting route files, hit the app root once
  (`curl -o /dev/null http://localhost:4190/`) before typechecking, or typecheck
  fails against the stale tree.

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
