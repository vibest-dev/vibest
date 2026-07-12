---
name: verify
description: Build/launch/drive recipe for verifying vibest web changes at runtime (dev server on localhost:4000)
---

# Verifying vibest at runtime

## Build + launch

```bash
# Start the dev server (run_in_background) — no prebuild needed:
# @vibest/harness exports src/*.ts directly and tsx resolves it.
cd packages/vibest && pnpm dev
```

This runs `NODE_ENV=development tsx src/node/cli.ts`: one server on **http://localhost:4000** with Vite middleware serving `apps/web`, oRPC at `/api/rpc`, WS at `/ws/rpc`. Health check: `curl http://localhost:4000/api/health` → `ok`.

Gotchas:

- Toolchain is pnpm + Turborepo (Vite+ was dropped in #87): `pnpm run check` = oxlint + oxfmt + turbo typecheck; `pnpm run format` to fix formatting.

## Flows worth driving

- Landing page → **Start Chatting** → creates a session and navigates to `/chat/<uuid>`.
- Type a prompt → send → user bubble right-aligned, assistant reply streams in on the left, textarea clears.
- Model select in the composer toolbar (Opus/Sonnet).

## Browser-automation gotchas

- Real Chrome with a temp profile + CDP port works; drive it via cua AX-tree clicks.
- CDP-synthesized `\n` keystrokes do NOT trigger the form's Enter-to-submit path — click the send button instead. Shift+Enter probing works (content stays put).
