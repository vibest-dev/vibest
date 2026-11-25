# Bun Runtime Boundary

The monorepo uses `pnpm` for package management. Bun is used only as:

1. The test runner (Vitest’s JS entry, via `pnpm run test`).
2. The standalone binary compiler (`bun build --compile`).

Business code has zero intrusion from proprietary Bun APIs:

- `bun:` imports, `@effect/*-bun` imports, and `Bun.*` runtime APIs (including `Bun.unsafe.setJITPolicy` in `packages/platform-bun/src/bun.ts`, see [packaging-and-platforms.md](packaging-and-platforms.md)) are restricted to `platform/` directories, the `packages/platform-bun` package, build scripts (`packages/cli/script/`), and adapter files named `bun.ts` or `*.bun.ts` (such as `packages/herdr-sdk/src/bun.ts`). Everywhere else, code must use standard Node.js / Web / POSIX APIs; embedded binary assets are materialized behind the CLI packaging boundary (`packages/cli/src/embedded-assets.ts`).
- Commands built for agents or prompt text (`VibestCommand`) may use PATH lookup or an absolute binary path, but must never leak internal compiled packaging paths such as `/$bunfs/`.
- Bun keeps a TTY stdin that was read referenced after the stream ends or `pause()`, so the platform's Stdio unrefs stdin when a read finishes; otherwise `vibest` would not exit after a `[y/N]` answer.
- The import rules are enforced by scoped `no-restricted-imports` overrides in `.oxlintrc.json` (part of `pnpm run typecheck`); `bun.ts`, `*.bun.ts` files, and `src/platform/` folders are exempt only from the Bun patterns; `Bun.*` usage is enforced by review.
- `packages/core` (and leaf packages like `packages/util`, `packages/schema`, `packages/protocol`, `packages/client` core) typecheck with no runtime's own types: `tools/tsconfig/web-globals.d.ts` declares only the web-standard globals Bun, Node and Deno all provide, so a runtime-specific global fails the typecheck.
