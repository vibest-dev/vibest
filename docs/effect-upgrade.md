# Effect upgrade checklist

The app depends on an exact Effect v4 beta and uses two unstable modules in
production (`effect/unstable/cli`, `effect/unstable/process`). Beta bumps can
compile clean and break only at runtime — server startup, child-process
lifecycle, or the packaged desktop app — so upgrades are deliberate, grouped,
and gated (issue #161).

## The compatibility set

| package                 | where it is pinned              |
| ----------------------- | ------------------------------- |
| `effect`                | `catalog:` exact pin + override |
| `@effect/platform-node` | `catalog:` exact pin + override |
| `@effect/vitest`        | `catalog:` exact pin + override |

The three move together, to the same version, in one PR. No automated or
independent bumps: `taze`/bots must never float them, and a caret is never
added — prerelease caret ranges admit newer betas and split the runtime.
`@effect/platform-node-shared` is transitive and may resolve one beta ahead
(the `effect` override keeps it on our runtime; the install-time peer warning
for it is the known, accepted state — see the comment in
`pnpm-workspace.yaml`). `@orpc/experimental-effect` rides `catalog:orpc` but
peer-depends on `effect`; read its peer warning on every Effect bump.

## The gate

`node tools/effect/compat-gate.mjs` (also `pnpm run check:effect`) fails when:

- any of the three is missing, range-versioned, or version-mismatched in the
  catalog;
- any of the three lacks its `"catalog:"` override;
- a workspace `package.json` declares an Effect-family dependency outside
  `catalog:`;
- the lockfile resolves more than one `effect` runtime, a runtime other than
  the pinned one, or multiple versions of any `@effect/*` package.

CI runs it before `pnpm install` on every push and PR, so drift is a
dependency-policy failure instead of a runtime surprise.

## Upgrade procedure

1. Bump all three catalog entries in `pnpm-workspace.yaml` to the same new
   beta. Nothing else in the same PR.
2. `pnpm install` — read the peer warnings. New warnings beyond the known
   `platform-node-shared` one (especially from `@orpc/experimental-effect`)
   mean the set is not compatible yet; stop.
3. `pnpm run check:effect` — must pass on the new lockfile.
4. `pnpm turbo run build test typecheck` — the lockfile change invalidates
   every package's cache, so the full suite actually runs. The focused
   compatibility surfaces are:
   - unstable CLI parsing: `packages/server/test/http/cli-flags.test.ts`
   - scoped child-process shutdown:
     `packages/server/test/harness/child-process.test.ts`
   - daemon lifecycle: `packages/server/test/daemon/*.test.ts`
   - RPC context execution (`@orpc/experimental-effect`):
     `packages/server/test/rpc-*.test.ts`
   - desktop runtime disposal:
     `apps/desktop/src/main/desktop-runtime-glue.test.ts`,
     `apps/desktop/src/main/application/desktop-application.test.ts`
5. `pnpm run lint:check && pnpm run format:check`.
6. Runtime smoke — the failures this doc exists for surface here, not in
   typecheck:
   - server: launch per `.claude/skills/verify` and drive a session;
   - CLI: `vibest daemon` start/status/stop round-trip (spawn + detach +
     signal handling exercise `effect/unstable/process` for real);
   - packaged desktop, whenever `effect/unstable/*` or `@effect/platform-*`
     imports changed: `pnpm --filter desktop e2e` (Playwright, not in CI).
7. Land the version bump plus any required code adaptations as one PR titled
   as an Effect upgrade, and note behavioural changes in the PR body.
