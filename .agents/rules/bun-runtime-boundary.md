# Bun Runtime Boundary

The monorepo uses `pnpm` for package management. Bun is used only as:

1. The test runner (Vitest’s JS entry, via `pnpm run test`).
2. The standalone binary compiler (`bun build --compile`).

Business code has zero intrusion from proprietary Bun APIs:

- `bun:` imports, `@effect/*-bun` imports, and `Bun.*` runtime APIs are restricted to `platform/` directories, the `packages/platform-bun` package and adapter files named `bun.ts` (such as `packages/effect-herdr-sdk/src/bun.ts`). Everywhere else, code must use standard Node.js / Web / POSIX APIs.
- Commands built for agents or prompt text (`VibestCommand`) may use PATH lookup or an absolute binary path, but must never leak internal compiled packaging paths such as `/$bunfs/`.
- Bun keeps a TTY stdin that was read referenced after the stream ends or `pause()`, so the platform's Stdio unrefs stdin when a read finishes; otherwise `vibest` would not exit after a `[y/N]` answer.
- The import rules are enforced by scoped `no-restricted-imports` overrides in `.oxlintrc.json`, plus the oxlint rule `vibest/import-boundaries` for dynamic `import()`, import types, `require` and import-equals (part of `pnpm run typecheck`); `Bun.*` usage is enforced by review.
- `packages/core` typechecks with no runtime's own types: `packages/core/types/web-globals.d.ts` declares only the web-standard globals Bun, Node and Deno all provide, so a runtime-specific global in core fails the typecheck.
