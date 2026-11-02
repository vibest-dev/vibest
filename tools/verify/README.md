# @vibest/verify

Private workspace package. Not published. `pnpm verify` proves vibest works the way a user gets it; it is the superset
of every other gate.

```sh
pnpm verify          # everything
pnpm verify daemon integration   # install as a user, then only these areas of E2E checks
```

In order, stopping at the first failure:

1. `pnpm run build`, `pnpm run typecheck`, `pnpm run test` (skipped when areas are given).
2. Each way a user installs vibest, into a temp directory, with nothing from this checkout:
   - **curl**: this platform's release archive (`scripts/build-archive.ts`), installed by `install.sh` run as
     `curl … | sh`, from `file://` (`VIBEST_DOWNLOAD_URL`, `VIBEST_INSTALL`, `VIBEST_BIN`).
   - **npm**: `pnpm pack` of `@vibest/cli` and this platform's binary package, then `npm install` of both tarballs.
3. For each install, `tools/e2e --strict` with `VIBEST_E2E_METHOD` (`curl` or `npm`) and `VIBEST_E2E_INSTALL`: every
   check drives the installed `vibest` on `PATH` and the plugins it ships, with real herdr and real harnesses; a skipped
   check fails.
4. Prints, by name, the feature-map checks marked `agent` or `runtime`: no script proves them, so an agent does, with
   evidence.

Areas: `daemon`, `project`, `plugins`, `harness`, `integration`, `guard`, `update`.

Nothing is published: no GitHub Release, no npm package, nothing in `~/.local`.
