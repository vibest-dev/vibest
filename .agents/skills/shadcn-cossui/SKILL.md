---
name: shadcn-cossui
description: Refresh packages/ui from the coss shadcn registry (`@coss` in components.json) and land the result. Use when the user wants to update/refresh coss ui components, runs `shadcn add`, or has a bulk packages/ui diff from a registry pull to review before committing.
---

# coss/ui refresh

`packages/ui`'s components under `src/components/` are vendored wholesale from the coss registry, not hand-written — read [the vendoring ADR](../../../docs/adr/0001-vendor-base-ui-components-from-coss-registry.md) before touching anything here; it's the source of truth for what's vendored, what's hand-maintained, and why, and this skill assumes it.

## Run the refresh

```bash
cd packages/ui && pnpm dlx shadcn@latest add @coss/ui --overwrite
```

`--overwrite` replaces every vendored file with whatever the registry serves today — a rolling "latest" with no versions. Any hand-edit sitting in a vendored file is discarded by this command; that's by design, not a bug to route around.

## Reassert this repo's standing exceptions

The registry assumes its own defaults — a Next.js host, its own font choices — that don't hold here. The ADR lists the current deviations; re-apply them after every refresh from the ADR itself, not from memory of what last refresh needed, since it's the registry's drift that changes, not this repo's exceptions.

## Format before judging scope

The registry's output isn't run through this repo's formatter. A meaningful chunk of any refresh diff is often pure noise — import order, Tailwind class order — that disappears once `pnpm format` runs. Run it early, then look at what's actually left; reviewing unformatted CLI output wastes effort on changes that were never real.

## Trust nothing a compiler can't check

Typecheck and lint only catch what they're built to catch. A wholesale text/CSS/asset overwrite can break things silently: a CSS custom property that stops being a `var(...)` reference and becomes a dead literal, a font-family string that doesn't match any actual `@font-face`, a `role`/`aria-*` attribute quietly dropped from an element that still carries an event handler. None of these fail a build. Read every changed non-TypeScript surface — `globals.css`, SVG paths, literal strings — by eye; don't infer correctness from green CI.

## Route fixes correctly

A real problem in the registry output is either this repo's documented exception (fix it in the vendored file, every refresh, per the ADR) or an upstream coss bug — which belongs in a wrapper component (`ai-elements/`, `claude-code/`) or an upstream report, never a hand-patch inside a vendored file. A hand-patch there is invisible work: it vanishes the next time `--overwrite` runs and the same bug has to be rediscovered from scratch.

## Verify before handing off

```bash
pnpm --filter @vibest/ui typecheck
pnpm --filter web typecheck
oxlint packages/ui/src
pnpm --filter web build
```

Done: all four clean, the diff reviewed post-format so it's scoped to real changes, and any true upstream bug routed to a wrapper or flagged — not silently patched into a vendored file.
