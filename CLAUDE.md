# vibest

In-browser tooling for AI coding agents: a web chat UI over local agents
(Claude Code, Codex, pi), served by a local Node daemon and also shipped as an
Electron app. pnpm + Turborepo, TypeScript everywhere.

## Commands

Run workspace tasks through turbo, not `pnpm --filter <pkg> <task>`: `build`,
`test`, and `typecheck` all declare `dependsOn: ["^build"]`, so bypassing turbo
skips the upstream tsdown build.

|                                               |                                                      |
| --------------------------------------------- | ---------------------------------------------------- |
| `pnpm test` / `pnpm typecheck` / `pnpm build` | scope with `turbo run test --filter=@vibest/server`  |
| `pnpm check`                                  | lint:check + format:check + typecheck — **no tests** |
| `pnpm lint` / `pnpm format`                   | rewrite files; the `:check` variants only report     |

`lint` and `format` are root-only (oxlint/oxfmt) and not turbo tasks. `test` and
`typecheck` are cached, so re-run with `--force` after changing something
outside their hash inputs. `pnpm clean` runs `git clean -xdf`.

## Rules

@.agents/rules/architecture.md
@.agents/rules/stack.md
@.agents/rules/frontend-state.md
@.agents/rules/toolchain.md

`apps/desktop/src` has its own layering contract in `apps/desktop/AGENTS.md` —
read it before touching that app.

## Going deeper

- `CONTEXT.md` — glossary. Read it before naming anything in the session domain;
  it also lists the words to avoid.
- `docs/adr/` — settled decisions (component vendoring; session field ownership,
  which supersedes the older `docs/design/session-agent-design.md` on `cwd`)
- `docs/design/`, `docs/2026-*.md` — designs in flight
- `docs/wayfinder/session-streaming-refactor/map.md` — streaming decisions that
  are closed for debate
- `.claude/skills/verify` — build, launch, and drive the app at runtime
- `.claude/skills/react-doctor` — React health check; CI fails on error-level only
- `todos/` — numbered security/perf remediation tickets
