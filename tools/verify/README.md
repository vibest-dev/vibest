# @vibest/verify

Private workspace package. Not published. `pnpm verify` proves vibest works the way a user gets it; it is the superset
of every other gate.

```sh
pnpm verify          # everything
pnpm verify daemon integration   # install as a user, then only these areas of E2E checks
pnpm verify --no-cache           # before a release: every check runs, the whole gate on both installs
pnpm verify --elsewhere H4       # leave these checks to another machine's verify (the release's Linux job leaves the
                                 # macOS-only H4 to its macOS job, which runs pnpm verify H4 on the same commit)
pnpm verify --keep-archive <dir> # build this platform's release archive into <dir> and keep it: the Release workflow
                                 # publishes the archive the curl install was checked with
pnpm verify --packs <dir>        # empty <dir>: pack every published package into it once and keep the tarballs; with
                                 # tarballs in it: pack nothing. Either way the npm install takes @vibest/cli and this
                                 # platform's binary package from <dir>, so the Release workflow publishes what it checked
```

verify is a deterministic program: CI runs it and it passes or fails. It does not read the capability docs in
`docs/features/`; an agent does, with the `verify-features` skill (`.agents/skills/verify-features/SKILL.md`), and uses
verify's results as evidence.

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
3. Prints `verify: passed.` when every leg passed.

Areas: `daemon`, `project`, `plugins`, `harness`, `integration`, `update`, `start`, `inbox`, `exits`, `restart`, `hc`,
`sessions`, `delivery`, `routing`, `main-agent`, `machines`, `terminal-status`; or check ids.

Nothing is published: no GitHub Release, no npm package, nothing in `~/.local`.

`bun tools/verify/src/release-artifacts.ts <version> --from <dir>` is the Release workflow's check before Publish, on
the tarballs `pnpm verify --packs <dir>` kept; it packs nothing. It checks `<dir>` holds exactly one tarball of each
published package, that each holds what its package.json declares (files, bin, main, exports, the harness plugins) and
`<version>`, installs `@vibest/cli` with this platform's binary package from them into an empty npm prefix and checks
that `vibest --version` prints `<version>`. It writes `publish-order` (dependencies first), which the publish job
publishes in that order, or checks an existing one. No harness, no model.
