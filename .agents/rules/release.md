# Release

1. **Trunk-based: `main` never carries a release version.** Every workspace package.json on `main` holds the development
   version `0.0.2-dev`; there is no version bump commit or pull request, and the tag `v<version>` is the only record of a
   release. `0.0.2-dev` sorts after every `0.0.2-beta.N` and `0.0.1` release, so a build from `main` is never
   offered an update to an older beta and `vibest update` installs nothing on it; E2E's older versions (digits zeroed:
   `0.0.0-dev`, and `0.0.0-old`) sort before it. Builds from different commits of `main` share it: like any two builds
   of one version, they do not tell each other apart. When the release line moves past it (a `0.0.3` beta, or the
   stable `0.0.2` itself), raise it on `main` in an ordinary pull request (`0.0.3-dev`); that is not a release.
2. **The Release workflow** (`.github/workflows/release.yml`) is the only way to release, started by the owner on
   `main` from the Actions page or with `gh workflow run release.yml -R vibest-dev/vibest --ref main`. It releases a
   chosen known-good commit of `main` (`-f commit=<sha>`, which must be an ancestor of `main`; without it, the head of
   `main`): every job builds, verifies, tags and publishes exactly that commit. The `plan` job computes the version
   from the `v*` tags only. `-f bump=beta` (the default) is the next `x.y.z-beta.n` after the highest tag (after a
   stable `x.y.z`, `x.y.(z+1)-beta.0`); `-f bump=patch|minor|major` is a stable `x.y.z` bumped from the highest stable
   tag, or, with no stable yet, from the base version of the highest beta (`0.0.1-beta.20` with patch is `0.0.1`, with
   minor `0.1.0`). `-f version=<x.y.z-beta.n|x.y.z>` overrides the bump with an exact version. Either way the version
   must be newer than the newest release of either channel. A stable release needs notes, `-f release_notes=<markdown>`
   or a CHANGELOG.md section `## <version>`, and `plan` refuses one without them; a beta's notes are optional. Each job
   writes the version into every package.json of `VERSIONED` in its own checkout with bumpp (`bumpp --release <version>
   <files> --no-commit --no-tag --no-push --yes`, a dev dependency at an exact version), never committing, tagging or
   pushing, and checks that every one carries it. The run fails when the version is already tagged or on npm. It runs
   the release gate on that tree: the whole of `pnpm verify --no-cache`,
   the single entry for all verification, whose stages run as parallel jobs on GitHub-hosted runners. `build` packs once
   (`--stage build,archive,pack`): the linux-x64 curl archive and every npm tarball, checks the tarballs, records the
   SHA-256 of every file and keeps them. `typecheck` and `test` are jobs of their own. `e2e` runs every E2E check on
   the curl install of that archive (`--stage e2e --leg curl <areas>`), one job per functional suite of E2E areas
   (`e2e/test/suites.test.ts` proves the suites name every area of `e2e/src/main.ts` exactly once; a new area goes
   into a suite), with `--elsewhere H4`; `e2e-npm`
   runs the install and launch checks (`NPM_CHECKS` in `tools/verify/src/verify.ts`) on the npm install of those
   tarballs (`--stage e2e --leg npm`). `ubuntu-latest` runs both, and `macos-latest` runs
   `pnpm verify --no-cache H4`, the macOS-only check, on the same commit and version, installing build's tarballs.
   Nothing is repacked, and `--no-cache` also forces turbo (`TURBO_FORCE`), so every check runs on every release. It
   keeps what verify installed and checked, then waits for the owner's approval (environment
   `release`). Only after the approval does it check those hashes, tag that commit `v<version>` (with
   `GITHUB_TOKEN`), publish exactly those tarballs to npm under the channel's dist-tag, and make the GitHub Release from exactly
   those archives. Nothing reads npm back after publishing (its reads lag behind a publish). Nothing is rebuilt or repacked after verify checked it. The release notes are
   `release_notes` when given, else the CHANGELOG.md section of the version, else (a beta only) GitHub's generated
   notes.

   There is no local release or publish path: nobody tags or publishes from a machine.

3. **Recovery.** A release that stopped partway is finished by re-running the failed publish job of the same run
   ("Re-run failed jobs"; its artifacts are kept 90 days). It keeps a tag already on that commit, each package already
   on npm with the same tarball integrity, and a published GitHub Release whose tag and assets match the checked files;
   it uploads the missing assets of a draft, compares every asset with the checked file, then publishes it. Anything
   else (a tag on another commit, a different tarball, a different or extra asset) fails the job. Never start a new run
   to finish a release: it builds new bytes, and it refuses a version that is already tagged or on npm. Changed code
   needs a new version.
4. **Channels: beta and stable.** The version decides the channel: `x.y.z-beta.n` is a beta, a plain `x.y.z` is
   stable, and the workflow refuses any other shape. A stable release is published under npm's `latest` and is a
   regular GitHub Release marked Latest; a beta is published under npm's `beta` (never moving `latest`) and is a GitHub
   prerelease. GitHub's Latest is therefore always the newest stable. `install.sh` installs the newest stable (Latest)
   and fails, naming `--beta`, when there is none; `install.sh --beta` installs the newest release of either channel,
   read from the release list (`releases.atom`). `vibest update` follows the channel of the installed version: a stable
   updates to the newest stable only, a beta (and a build from `main`, `0.0.2-dev`) to the newest release of either
   channel, so a beta user moves to a stable once it is newer; `--stable` and `--beta` choose explicitly. An npm install
   reads the same from `@vibest/cli`'s dist-tags (`latest` for stable, the newer of `latest` and `beta` for either
   channel). Both channels stay in this same workflow file: npm trusted publishing binds each package to one workflow
   file name, `release.yml`, so the file is never renamed.
5. **Bugs are fixed on `main` and rolled forward.** There are no release branches: a bug found in a release is fixed on
   `main` like any change, and a new release ships it, cut from a known-good commit of `main` that contains the fix. A
   released version is never rebuilt, re-tagged or patched in place.
6. Agents may prepare a release (fixes, the changelog) and start a run when the owner asks, and may run it
   with `-f dry_run=true` (every gate, then stop: nothing tagged or published) on any branch; a dry run only warns when
   the version is already released. Agents never approve the `release` environment, push `v*` tags, or publish to npm
   themselves.
7. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run must be on `main`.
8. The workflow's `VERSIONED` list names every workspace package.json that carries the version, the files bumpp writes;
   a new package goes into it, and every file in it holds `0.0.2-dev` on `main`. bumpp gets the files, not `-r`: `-r`
   would also rewrite the unreleased `tools/bench` and `e2e`.
9. The gate is `pnpm verify` as it is: the workflow runs its stages (`--stage`, `--leg`, areas) in parallel jobs and
   replaces no part of it with other commands. Every stage, every leg and every area must run: a new area goes into
   a suite of the matrix. A part the runner cannot run fails the run; fix the runner or verify, never narrow the gate.

## Owner checklist

Settings the workflow needs and cannot set itself. Check them before the first release and after any change:

- [ ] Environment `release`: required reviewer the owner; "Prevent self-review" off (the owner both starts and approves
      the run); deployment branches: selected, `main` only; "Allow administrators to bypass" off.
- [ ] Immutable releases on (Settings, General, Releases): a published release's tag and assets cannot change, and the
      release gets an attestation. Drafts stay editable, which recovery relies on.
- [ ] npm trusted publisher on each published package (8 packages total: `@vibest/cli`, `@vibest/plugin`, and all 6 platform packages `@vibest/cli-darwin-arm64`, `@vibest/cli-darwin-x64`, `@vibest/cli-linux-arm64`, `@vibest/cli-linux-arm64-musl`, `@vibest/cli-linux-x64`, `@vibest/cli-linux-x64-musl`; `@vibest/schema` and `effect-herdr-sdk` are `"private": true` and not published): GitHub Actions, repository `vibest-dev/vibest`, workflow `release.yml`, environment `release`, "Allow npm publish" on (a new configuration otherwise only allows staged publishing). npm OIDC cannot create brand-new package names, so before the first release with the 4 new platform targets, pre-create and trust each one:

      ```sh
      for pkg in \
        @vibest/cli @vibest/plugin \
        @vibest/cli-darwin-arm64 @vibest/cli-darwin-x64 \
        @vibest/cli-linux-arm64 @vibest/cli-linux-arm64-musl \
        @vibest/cli-linux-x64 @vibest/cli-linux-x64-musl; do
        npm trust github "$pkg" --file release.yml --repo vibest-dev/vibest --env release --allow-publish
      done
      ```

      Each package.json `repository.url` is `git+https://github.com/vibest-dev/vibest.git`, which provenance requires.

- [ ] Once a release has published with OIDC: revoke any npm token that could publish these packages.
- [ ] npm 11.5.1 or later in the publish job (Node 26.13.0 ships 11.20.0; the job checks it), Node 22.14.0 or later.
- [ ] No deploy key, no `RELEASE_PUSH_KEY` secret and no DeployKey bypass on "CI required on main": the workflow never
      pushes to `main`.

Status: in force.
