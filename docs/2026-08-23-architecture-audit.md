# Architecture audit — 2026-08-23

Scheduled review of the vibest monorepo against `.agents/rules/architecture.md`,
`stack.md`, `frontend-state.md`, `ui-components.md`, and `apps/desktop/AGENTS.md`.

## Summary

Package boundaries are largely healthy: no `@vibest/app` → server imports, no
`@vibest/ui` barrel imports, desktop layering is clean, and `EventBusLayer` is a
single const in `packages/server/src/rpc/runtime.ts` (no `Layer.fresh` in
production). Persistent paths stay in `packages/server/src/config/paths.ts`; HTTP
concerns stay under `packages/server/src/http/`.

The highest-impact debt clusters in three areas:

1. **Vendored UI boundary** — hand-maintained code living inside
   `packages/ui/src/components/` (Tiptap, loading `Button`, `frame`/`kbd`).
2. **Feature ownership in the SPA** — content panels and conversation UI split
   across shell and feature directories; module-scope browser APIs at import time.
3. **Harness / Effect test isolation** — tests that memoize stateful Layers or
   wire private session collaborators directly.

## New issues filed this audit

| Issue | Severity | Topic |
| ----- | -------- | ----- |
| [#280](https://github.com/vibest-dev/vibest/issues/280) | P2 | Tiptap UI in vendored `components/` tree |
| [#281](https://github.com/vibest-dev/vibest/issues/281) | P2 | EventBus tests use memoizing `layer()` |
| [#279](https://github.com/vibest-dev/vibest/issues/279) | P3 | Local `frame`/`kbd` in vendored tree |
| [#282](https://github.com/vibest-dev/vibest/issues/282) | P3 | Loading patch in vendored `button.tsx` |
| [#283](https://github.com/vibest-dev/vibest/issues/283) | P3 | `sessionId` prop name vs `sessionKey` in files feature |

## Open issues from prior audits (still relevant)

| Issue | Severity | Topic |
| ----- | -------- | ----- |
| [#269](https://github.com/vibest-dev/vibest/issues/269) | — | `localStorage` at `content-panel` module init |
| [#270](https://github.com/vibest-dev/vibest/issues/270) | — | Split content-panel definition ownership |
| [#271](https://github.com/vibest-dev/vibest/issues/271) | P3 | Move `Conversation` composite to `@vibest/ui` |
| [#272](https://github.com/vibest-dev/vibest/issues/272) | — | Stop exporting `makeEventBus` publicly |
| [#273](https://github.com/vibest-dev/vibest/issues/273) | — | Desktop imports `@vibest/server/daemon` directly |
| [#275](https://github.com/vibest-dev/vibest/issues/275) | — | Files feature reads route identity via `useMatch` |
| [#276](https://github.com/vibest-dev/vibest/issues/276) | — | Automated lint rules for package/feature boundaries |
| [#277](https://github.com/vibest-dev/vibest/issues/277) | P3 | Narrow `harness/index.ts` exports |
| [#267](https://github.com/vibest-dev/vibest/issues/267) | — | Duplicate `HarnessAgentId` whitelist in server |
| [#268](https://github.com/vibest-dev/vibest/issues/268) | — | `session-repository` hardcodes harness IDs |
| [#262](https://github.com/vibest-dev/vibest/issues/262) | P2 | Placeholder panels in layout instead of features |

## Findings detail

### 1. Vendored UI tree contains owned code (P2)

`packages/ui/src/components/*` is refreshed with `shadcn add @coss/ui
--overwrite` (ADR 0001). The following are hand-written and at risk on the next
registry pull:

- **Tiptap** — `components/tiptap/*` + `hooks/tiptap/*` (#280)
- **Loading Button** — `components/button.tsx` adds `loading` prop and Spinner
  (#282)
- **Frame / Kbd** — local primitives alongside vendored files (#279)

**Fix direction:** move durable UI to `ai-elements/` or feature wrappers; revert
vendored files to registry versions.

### 2. SPA feature ownership (P2–P3)

`frontend-state.md` models chat as the reference feature: everything a feature
needs lives under `features/<name>/`.

- **Content panels** — `files-panel.tsx` is in `features/files/`, but
  terminal/browser/diff panels live in
  `components/layout/content-panel/panels/` (#270, #262).
- **Conversation UI** — chat-only composite in `apps/app/src/components/`
  (#271).
- **Module-scope init** — `content-panel.ts` touches `window.localStorage` at
  import; `__root.tsx` registers panels at module load (#269).

**Fix direction:** colocate panels with features; construct `ContentPanel` at app
mount inside a provider.

### 3. Harness export and test boundaries (P2–P3)

`architecture.md` defines five public session roles; `session.ts`,
`session-fold.ts`, and `session-repository.ts` are private collaborators.

- **Public exports too wide** — `harness/index.ts` re-exports `executable`,
  `queue-stream`, `session-io`, etc. (#277)
- **EventBus factory exported** — `makeEventBus` reachable outside composition
  root (#272)
- **Test wiring** — `session.test.ts`, `session-repository.test.ts`, and
  `session-service.test.ts` import private factories directly; prefer integration
  through `HarnessAgentSessionServiceLayer`
- **Layer memoization in tests** — `events.test.ts` and `session.test.ts` share
  memoized Layers (#281, related #159)

### 4. Contract / server identity drift (P3)

- `HarnessAgentIdSchema` in contract is the whitelist, but server types duplicate
  the literal union (#267)
- `session-repository` hardcodes harness IDs instead of decoding via contract
  schema (#268)

### 5. Desktop daemon import path (P3)

`apps/desktop/src/main/server/daemon-server-process.ts` imports
`@vibest/server/daemon` directly (#273). Review whether this violates the
desktop layering contract or is an intentional exception for process supervision.

### 6. Naming: session identity in files feature (P3)

`FileTreeAdapter` prop is named `sessionId` but receives `sessionRefKey(...)` —
a composite key, not a bare UUID (#283).

## What looks clean

- **Import graph:** `contract ← server ← cli|desktop` and
  `contract ← client ← app ← desktop` respected in production code.
- **Feature cross-imports:** none detected across `apps/app/src/features/`.
- **Query keys:** cache writers use `queryOptions(...).queryKey`; `.key()` only
  for invalidation.
- **Codex protocol:** ts-rs generated files carry `GENERATED CODE` headers; not
  hand-edited.
- **Desktop renderer:** uses root `@vibest/app` exports only; `ipcRenderer`
  confined to preload.

## Recommended priority

1. **P2 — vendored UI** (#280, then #282, #279) before the next coss registry
   refresh.
2. **P2 — test isolation** (#281) to reduce flaky harness tests.
3. **P2–P3 — SPA feature model** (#269, #270, #271, #262) for maintainability
   as new panel types land.
4. **P3 — harness export narrowing** (#277, #272, #267, #268) as incremental
   refactors.

## Method

Automated scan (import direction, barrel usage, `Layer.fresh`, feature
cross-imports, vendored-tree contents) plus manual spot-checks of harness tests,
content-panel registration, and desktop main-process imports.
