# AGENTS.md

## Guidelines

Project rules live in [`.agents/rules/`](.agents/rules/). Read them before changing code in this repository.

## Verifying a change

Run from the checkout; nothing is installed for you. Each gate counts by its exit status.

```sh
pnpm install && pnpm build   # apps/vibest-herdr/dist/vibest and its harness plugins in apps/vibest-herdr/harnesses/
pnpm typecheck && pnpm test  # fakes only: no herdr, no harness, no model
pnpm e2e [area…]             # scripted checks: the built binary, real herdr and harnesses
pnpm verify [area…]          # the superset: all of the above, then the E2E checks on a curl and an npm install of this checkout
```

`pnpm verify` is what says vibest works as a user gets it: run it before calling a change done, then prove the
`agent` and `runtime` checks it lists (docs/testing/feature-map.md) with evidence. E2E gives every run a temp
`VIBEST_HOME` and the user's real `HOME` (the harness logins live there), reads the user's harness config without
writing it, and leaves evidence in `tools/e2e/evidence/<run>/`. Do not run a bare `vibest` against the user's own
`~/.vibest` or herdr session to try a change; add or run an E2E check instead.
