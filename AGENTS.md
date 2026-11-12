# AGENTS.md

## Guidelines

Project rules live in [`.agents/rules/`](.agents/rules/). Read them before changing code in this repository.

## Verifying a change

Run from the checkout; nothing is installed for you. Each gate counts by its exit status.

```sh
pnpm install && pnpm build   # packages/cli/dist/vibest and its harness plugins in packages/cli/harnesses/
pnpm typecheck && pnpm test  # fakes only: no herdr, no harness, no model
pnpm e2e [area…]             # scripted checks: the built binary, real herdr and harnesses
pnpm verify [area…]          # the superset: all of the above, then the E2E checks on a curl and an npm install of this checkout
```

Unit tests run no git: they state the repository facts they need on the in-memory `FakeGit`
(`packages/cli/test/fake-git.ts`). The exceptions are `packages/cli/test/git.test.ts`, which tests the live `Git`
layer against real git with its own `HOME` and identity, and the live herdr tests
`packages/cli/test/runtime-herdr-subagent.test.ts` and `runtime-herdr-close.test.ts`, which are skipped without herdr
(the first starts a real Pi when it is on `PATH`).

The scripts (`pnpm test`, `pnpm e2e`, `pnpm verify`) are deterministic: CI runs them, and they pass or fail. They do
not say a change works on their own. What vibest can do, and when each
capability counts as working, is written in plain language in [docs/features/](docs/features/), one file per area,
each capability under its id; a new or changed capability goes there, and the E2E check about it carries that id in its
name. To say a change works, an agent runs the `verify-features` skill
([.agents/skills/verify-features/SKILL.md](.agents/skills/verify-features/SKILL.md)): read the capabilities, run `pnpm
verify`, use its results, verify the rest by hand in an isolated real environment, and report each capability with
evidence. E2E gives every run a temp
`VIBEST_HOME` and the user's real `HOME` (the harness logins live there), reads the user's harness config without
writing it, and leaves evidence in `tools/e2e/evidence/<run>/`. Do not run a bare `vibest` against the user's own
`~/.vibest` or herdr session to try a change; add or run an E2E check instead.
