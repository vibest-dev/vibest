# Release

1. **Trunk-based: `main` never carries a release version.** Every workspace package.json on `main` holds the development
   version `0.0.1-dev`; there is no version bump commit or pull request, and the tag `v<version>` is the only record of a
   release. `0.0.1-dev` sorts after every `0.0.1-beta.N` release, so a build from `main` is never offered an update to
   an older beta and `vibest update` installs nothing on it; E2E's older versions (digits zeroed: `0.0.0-dev`, and
   `0.0.0-old`) sort before it. Builds from different commits of `main` share it: like any two builds of one version,
   they do not tell each other apart. When the release line moves past it (a `0.0.2` beta, or `0.0.1` itself), raise
   it on `main` in an ordinary pull request (`0.0.2-dev`); that is not a release.
2. **The Release workflow** (`.github/workflows/release.yml`) is the only way to release, started by the owner on
   `main` from the Actions page or with `gh workflow run release.yml -R vibest-dev/vibest --ref main`. It releases a
   chosen known-good commit of `main` (`-f commit=<sha>`, which must be an ancestor of `main`; without it, the head of
   `main`): every job builds, verifies, tags and publishes exactly that commit. `-f version=<x.y.z-beta.n>` names the
   version, which must be newer than the newest release; without it, the next beta after the highest
   `v<x.y.z>-beta.<n>` tag. It sets that version in every package.json of its own checkout only and fails when the
   version is already tagged or on npm. It runs the release gate on that tree: the whole of `pnpm verify --no-cache`,
   the single entry for all verification, whose stages run as parallel jobs on GitHub-hosted runners. `build` packs once
   (`--stage build,archive,pack`): the linux-x64 curl archive and every npm tarball, checks the tarballs, records the
   SHA-256 of every file and keeps them. `typecheck` and `test` are jobs of their own. `e2e` runs every E2E check on the
   curl install of that archive and on the npm install of those tarballs (`--stage e2e --leg curl|npm --shard k/n`),
   each leg split into shards balanced by the measured durations in `tools/e2e/src/runner/shard-weights.ts`
   (`tools/e2e/test/shard.test.ts` proves the shards cover every check exactly once; refresh the weights when checks are
   added or change a lot). `ubuntu-latest` runs them with `--elsewhere H4`, and `macos-latest` runs
   `pnpm verify --no-cache H4`, the macOS-only check, on the same commit and version, installing build's tarballs.
   Nothing is repacked, and `--no-cache` also forces turbo (`TURBO_FORCE`), so every check runs on every release. It
   keeps what verify installed and checked, then waits for the owner's approval (environment
   `release`). Only after the approval does it check those hashes, tag that commit `v<version>` (with
   `GITHUB_TOKEN`), publish exactly those tarballs to npm, make the GitHub Release from exactly those archives, and check
   every package's dist-tag. Nothing is rebuilt or repacked after verify checked it. A CHANGELOG.md section for the
   version (`## <version>`) is optional.

   There is no local release or publish path: nobody tags or publishes from a machine.

3. **Recovery.** A release that stopped partway is finished by re-running the failed publish job of the same run
   ("Re-run failed jobs"; its artifacts are kept 90 days). It keeps a tag already on that commit, each package already
   on npm with the same tarball integrity, and a published GitHub Release whose tag and assets match the checked files;
   it uploads the missing assets of a draft, compares every asset with the checked file, then publishes it. Anything
   else (a tag on another commit, a different tarball, a different or extra asset) fails the job. Never start a new run
   to finish a release: it builds new bytes, and it refuses a version that is already tagged or on npm. Changed code
   needs a new version. A dist-tag that does not point at the version is reported, not moved: move it by hand only when
   no newer release owns it.
4. **Channels: beta only for now.** Every release is a beta, `x.y.z-beta.n` (the workflow refuses any other version),
   published under npm's `beta`, and a regular GitHub Release marked Latest, not a prerelease, because `install.sh` and
   `vibest update` follow GitHub's Latest release. The notes are the CHANGELOG.md section of the version when there is
   one, otherwise GitHub's generated notes. A stable channel, added before the first stable release, will need: stable
   versions published under npm's `latest` (betas keep `beta`); betas made GitHub prereleases, so Latest is the newest
   stable; and `install.sh` and `vibest update` choosing a channel (stable by default, beta on request) instead of
   following Latest. It stays in this same workflow file: npm trusted publishing binds each package to one workflow file
   name, `release.yml`, so the file is never renamed.
5. **Bugs are fixed on `main` and rolled forward.** There are no release branches: a bug found in a release is fixed on
   `main` like any change, and a new release ships it, cut from a known-good commit of `main` that contains the fix. A
   released version is never rebuilt, re-tagged or patched in place.
6. Agents may prepare a release (fixes, the changelog) and start a run when the owner asks, and may run it
   with `-f dry_run=true` (every gate, then stop: nothing tagged or published) on any branch; a dry run only warns when
   the version is already released. Agents never approve the `release` environment, push `v*` tags, or publish to npm
   themselves.
7. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run must be on `main`.
8. The workflow's `VERSIONED` list names every workspace package.json that carries the version; a new package goes into
   it, and every file in it holds `0.0.1-dev` on `main`.
9. The gate is `pnpm verify` as it is: the workflow runs its stages (`--stage`, `--leg`, `--shard`) in parallel jobs and
   replaces no part of it with other commands. Every stage, every leg and every shard must run: a new shard goes into
   the matrix and `SHARDS`. A part the runner cannot run fails the run; fix the runner or verify, never narrow the gate.

## Owner checklist

Settings the workflow needs and cannot set itself. Check them before the first release and after any change:

- [ ] Environment `release`: required reviewer the owner; "Prevent self-review" off (the owner both starts and approves
      the run); deployment branches: selected, `main` only; "Allow administrators to bypass" off.
- [ ] Immutable releases on (Settings, General, Releases): a published release's tag and assets cannot change, and the
      release gets an attestation. Drafts stay editable, which recovery relies on.
- [ ] npm trusted publisher on each published package, `@vibest/cli`, `@vibest/cli-darwin-arm64`,
      `@vibest/cli-linux-x64`, `@vibest/schema`, `@vibest/plugin` and `effect-herdr-sdk`: GitHub Actions, repository
      `vibest-dev/vibest`, workflow `release.yml`, environment `release`, "Allow npm publish" on (a new configuration otherwise only
      allows staged publishing), for example
      `npm trust github @vibest/cli --file release.yml --repo vibest-dev/vibest --env release --allow-publish`.
      Each package.json `repository.url` is `git+https://github.com/vibest-dev/vibest.git`, which provenance requires.
- [ ] Once a release has published with OIDC: revoke any npm token that could publish these packages.
- [ ] npm 11.5.1 or later in the publish job (Node 26.13.0 ships 11.20.0; the job checks it), Node 22.14.0 or later.
- [ ] No deploy key, no `RELEASE_PUSH_KEY` secret and no DeployKey bypass on "CI required on main": the workflow never
      pushes to `main`.

Status: in force.
