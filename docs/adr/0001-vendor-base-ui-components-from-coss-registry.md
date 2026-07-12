# Vendor base UI components from the coss registry

The base components in `packages/ui/src/components/` are not hand-written: they are vendored wholesale from the coss registry (`@coss` in `components.json`, Base UI primitives, neutral palette) via `shadcn add @coss/ui --overwrite`, and local edits to them are expected to be discarded on the next refresh. Exceptions: `carousel` (embla) and `splitter` (Ark UI) are maintained locally because coss does not carry them.

## Consequences

- Fixes belong upstream or in wrapper components (`ai-elements/`, `claude-code/`), never in the vendored files.
- The registry is a rolling "latest" with no versions; a refresh takes whatever coss serves that day, and consumers are adapted to API changes as part of the refresh.
- We deliberately do NOT install coss's font packages: its `geist` npm package depends on Next.js (dragging `next` + `sharp` into a plain Vite library). Fonts stay on `@fontsource-variable/geist`, wired into the coss theme via `--font-sans`/`--font-mono` in `globals.css`.
