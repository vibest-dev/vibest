# vibest

In-browser tooling for AI coding agents: a web chat UI over local agents
(Claude Code, Codex, pi, Grok), served by a local Node daemon and also shipped as an
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
outside their hash inputs. `pnpm clean` runs `turbo run clean` then
`git clean -xdf node_modules dist .turbo` — not a repo-wide `git clean -xdf`.
Runtime UI checks use `.agents/skills/verify` (launch the vite app plus server,
then drive the page).

## Rules

@.agents/rules/architecture.md
@.agents/rules/stack.md
@.agents/rules/frontend-state.md
@.agents/rules/ui-components.md
@.agents/rules/toolchain.md

`apps/desktop/src` has its own layering contract in `apps/desktop/AGENTS.md` —
read it before touching that app.

## Pull requests

Use **squash merge** — one commit per PR keeps `main` readable. Don't mix
merge-commit / rebase merges in the repo. Squash rewrites the branch tip out
of `main`'s history, so deleting the local feature branch needs `git branch -D`
— the changes are already on `main`, so it's safe.

## Going deeper

- `CONTEXT.md` — glossary. Read it before naming anything in the session domain;
  it also lists the words to avoid.
- `docs/adr/` — settled decisions (component vendoring; session field ownership,
  which supersedes the older `docs/design/session-agent-design.md` on `cwd`)
- `docs/design/`, `docs/2026-*.md` — designs in flight
- `docs/wayfinder/session-streaming-refactor/map.md` — streaming decisions that
  are closed for debate
- `.agents/skills/verify` — build, launch, and drive the app at runtime
- `.agents/skills/react-doctor` — React health check; CI fails on error-level only
- `todos/` — numbered security/perf remediation tickets

## Cursor Cloud specific instructions

Node 24 is required (`mise.toml`, and `@vibest/cli` `engines`). `mise` is not
installed on the cloud VM; Node 24 comes from `nvm`, and `pnpm` from corepack.
The base image also ships a Node 22 at `/exec-daemon/node` that shadows nvm's
Node on `PATH` in **non-login** shells. Two consequences:

- Login shells (a `bash -l`, and every tmux-backed terminal) already resolve
  Node 24 + corepack `pnpm` — run dev servers, `pnpm test`, etc. from those.
- In a bare non-login shell you may get Node 22 with no `pnpm`. Fix the shell
  with `. "$NVM_DIR/nvm.sh" && nvm use 24 && corepack enable` (or just run a
  login shell). The startup update script installs deps under Node 24, so
  `node-pty`'s native build matches what login shells run — don't reinstall
  under Node 22 or the runtime ABI won't match.

Running the app is two processes (Vite on 4190 proxying `/api` + `/ws/rpc` to
the server on 4180) — see `.claude/skills/verify/SKILL.md` for the exact
recipe and gotchas. `pnpm dev` at the root runs both through turbo.

Getting an actual agent reply needs a Claude Code credential and binary, neither
of which the base VM has:

- The `claude` binary is not on `PATH`. The server resolves it from the Agent
  SDK's bundled platform package only via `moduleRequire`, which fails under
  pnpm's layout — so export `VIBEST_CLAUDE_EXECUTABLE` to
  `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@<ver>/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
  for the server process, or Claude Code shows up unavailable in the composer.
- Even when available, a prompt turn ends with `Not logged in · Please run
/login` unless `ANTHROPIC_API_KEY` (or a `claude login`) is present. The
  project-import → session-create → prompt-submit flow (user message renders,
  URL moves to `/session/<uuid>`) works without it; only the model reply needs
  the credential.
