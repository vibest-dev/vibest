# Bun Runtime Boundary Rule

The monorepo uses `pnpm` for package management. Bun is used only as:

1. The test runner (Vitest’s JS entry, via `pnpm run test`).
2. The standalone binary compiler (`bun build --compile`).

Business code has zero intrusion from proprietary Bun APIs:

- `bun:` imports, `@effect/*-bun` imports, and `Bun.*` runtime APIs are restricted to `platform/` directories and adapter files named `bun.ts` (such as `packages/effect-herdr-sdk/src/bun.ts`). Everywhere else, code must use standard Node.js / Web / POSIX APIs.
- Commands built for agents or prompt text (`VibestCommand`) may use PATH lookup or an absolute binary path, but must never leak internal compiled packaging paths such as `/$bunfs/`.
- The import rules are enforced by `pnpm run check:runtime` (part of `pnpm run typecheck`); `Bun.*` usage is enforced by review.
