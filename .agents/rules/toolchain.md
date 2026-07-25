# Toolchain constraints

- **Dependencies:** `pnpm-workspace.yaml` has three catalogs (`catalog:`,
  `catalog:orpc`, `catalog:tiptap`) plus `overrides` that pull _transitive_ deps
  onto catalog versions — bumping a package's own `package.json` for `vite`,
  `vitest`, `effect`, or `@effect/*` does nothing. Several pins are caret-free
  because a caret breaks the runtime. The reasons are commented inline; read them
  before changing versions. `packages/server` pins the Claude SDK as a literal
  while `packages/vibest` uses `catalog:` — bump both together.
- **Lint:** `lint:check` runs `--deny-warnings`, so the whole `suspicious`
  category fails CI while only warning locally. oxfmt reorders imports.
- **Commits rewrite files:** pre-commit runs lint-staged (`oxlint --fix` + `oxfmt`)
  over every staged file. No typecheck, no tests. `SKIP_SIMPLE_GIT_HOOKS=1` skips
  it. Hooks only exist after `pnpm install` — `prepare` sets `core.hooksPath`,
  which is also what makes them fire inside worktrees.
- **Tests:** no root vitest workspace; every package has its own config and goes
  through turbo. Layout is inconsistent — `server`/`contract`/`harness` use
  `test/`, everyone else colocates `src/**/*.test.ts` behind an explicit
  `include`, so a test file placed elsewhere is silently ignored. `server` and
  `harness` enable `test.typecheck`, so type errors fail the run.
  `apps/desktop/e2e/` is Playwright and not in CI. `tools/testing/fake-claude.mjs`
  is referenced by relative path from both server tests and desktop e2e.
