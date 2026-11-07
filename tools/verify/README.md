# @vibest/verify

Private workspace package. Not published. `pnpm verify` proves vibest works the way a user gets it; it is the superset
of every other gate.

```sh
pnpm verify          # everything
pnpm verify daemon integration   # install as a user, then only these areas of E2E checks
pnpm verify --no-cache           # before a release: every check runs, the whole gate on both installs
```

A failed build, typecheck, test, pack or install stops the run; a failed E2E leg does not stop the other leg, and the
run fails at the end naming each failed leg:

1. `pnpm run build` (Turborepo, cached), then at the same time: `pnpm run typecheck` and `pnpm run test` (skipped when
   areas or ids are given), and each way a user installs vibest, into a temp directory, with nothing from this checkout:
   - **curl**: this platform's release archive (`scripts/build-archive.ts`), installed by `install.sh` run as
     `curl … | sh`, from `file://` (`VIBEST_DOWNLOAD_URL`, `VIBEST_INSTALL`, `VIBEST_BIN`).
   - **npm**: `pnpm pack` of `@vibest/cli` and this platform's binary package, then `npm install` of both tarballs.
2. Both installs at the same time, `tools/e2e --strict` with `VIBEST_E2E_METHOD` (`curl` or `npm`) and
   `VIBEST_E2E_INSTALL`: every check drives the installed `vibest` on `PATH` and the plugins it ships, with real herdr
   and real harnesses; a skipped check fails. The curl install runs the whole gate. The npm install holds the same
   binary bytes, so it runs the smoke set (I1, I2, U1, U9, U10, H1) while its file layout (paths and links) matches the
   last one that passed the whole gate, and the whole gate when it changed. Checks whose key is unchanged are cache hits
   (docs/testing/e2e-plan.md §3).
3. Prints, by name, the feature-map checks marked `agent`, `slow` or `runtime`: no gate script proves them, so an agent
   does, with evidence.

Areas: `daemon`, `project`, `plugins`, `harness`, `integration`, `update`, `start`, `inbox`, `exits`, `restart`, `hc`,
`terminal-status`; or check ids.

Nothing is published: no GitHub Release, no npm package, nothing in `~/.local`.

`bun tools/verify/src/release-artifacts.ts <version> [--out <dir> | --from <dir>]` is the Release workflow's check
before Publish: it packs every published package (or, with `--from`, takes the tarballs an earlier `--out` run kept in
`<dir>`), checks each tarball holds what its package.json declares (files, bin, main, exports, the harness plugins),
installs the packed `@vibest/cli` with this platform's binary package into an empty npm prefix and checks that
`vibest --version` prints `<version>`. `--out` keeps the checked tarballs and `publish-order` (dependencies first),
which the publish job publishes as they are. No harness, no model.
