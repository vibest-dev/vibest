# Release

1. A release has two steps, and neither pushes to `main` outside a pull request:
   - **The release pull request.** On a new branch from `main`, `pnpm bump --release <prerelease, patch, minor, major or
     an exact version>` sets every package version and commits only that change ("chore: release v<version>"; no tag,
     no push). A CHANGELOG.md section for the version (`## <version>`) is optional. Push the branch and open the pull
     request; it merges like any change, through CI's required check, by the owner or the coordinator.
   - **The Release workflow** (`.github/workflows/release-beta.yml`), started by the owner on `main` from the Actions
     page or with `gh workflow run release-beta.yml -R vibest-dev/vibest --ref main`. It releases main's version as it
     is and fails when that version is already tagged or on npm. It runs the release gate on main's commit (the whole
     of `pnpm verify --no-cache`, the single entry for all verification, on GitHub-hosted runners: `ubuntu-latest` runs
     it with `--elsewhere H4`, and `macos-latest` runs `pnpm verify --no-cache H4`, the macOS-only check, on the same
     commit), packs the npm tarballs and checks them on Linux and macOS, keeps the curl archive each platform's verify
     installed and checked (`--keep-archive`), records the SHA-256 of every kept file, then waits for the owner's
     approval (environment `release`). Only after the approval does it check those hashes, tag that commit
     `v<version>` (with `GITHUB_TOKEN`), publish exactly those tarballs to npm, make the GitHub Release from exactly
     those archives, and check every package's dist-tag. Nothing is rebuilt after verify checked it.

   There is no local release or publish path: nobody tags or publishes from a machine.

2. **Recovery.** A release that stopped partway is finished by re-running the failed publish job of the same run
   ("Re-run failed jobs"; its artifacts are kept 90 days). It keeps a tag already on that commit, each package already
   on npm with the same tarball integrity, and a published GitHub Release whose tag and assets match the checked files;
   it uploads the missing assets of a draft, compares every asset with the checked file, then publishes it. Anything
   else (a tag on another commit, a different tarball, a different or extra asset) fails the job. Never start a new run
   to finish a release: it builds new bytes, and it refuses a version that is already tagged or on npm. Changed code
   needs a new version. A dist-tag that does not point at the version is reported, not moved: move it by hand only when
   no newer release owns it.
3. **Channels.** A version with a prerelease part (`0.0.1-beta.19`) is published under npm's `beta`, a plain one under
   `latest`. The GitHub Release is a regular release marked Latest, not a prerelease, also for a beta: `install.sh` and
   `vibest update` follow GitHub's Latest release. Separate a stable channel (GitHub prereleases, an installer and
   updater that choose a channel) before the first stable release. The notes are the CHANGELOG.md section of the
   version when there is one, otherwise GitHub's generated notes.
4. Agents may prepare a release (the release pull request, fixes) and start a run when the owner asks, and may run it
   with `-f dry_run=true` (every gate, then stop: nothing tagged or published) on any branch; a dry run only warns when
   the version is already released. Agents never approve the `release` environment, push `v*` tags, or publish to npm
   themselves.
5. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run must be on `main`.
6. The root `bump` script and the workflow's Version step list the same package.json files; a package added to one goes
   into the other.
7. The gate is `pnpm verify` as it is: the workflow does not replace any part of it with other commands. A part the
   runner cannot run fails the run; fix the runner or verify, never narrow the gate.

## Owner checklist

Settings the workflow needs and cannot set itself. Check them before the first release and after any change:

- [ ] Environment `release`: required reviewer the owner; "Prevent self-review" off (the owner both starts and approves
      the run); deployment branches: selected, `main` only; "Allow administrators to bypass" off.
- [ ] Immutable releases on (Settings, General, Releases): a published release's tag and assets cannot change, and the
      release gets an attestation. Drafts stay editable, which recovery relies on.
- [ ] npm trusted publisher on each published package, `@vibest/cli`, `@vibest/cli-darwin-arm64`,
      `@vibest/cli-linux-x64`, `@vibest/plugin` and `effect-herdr-sdk`: GitHub Actions, repository `vibest-dev/vibest`,
      workflow `release-beta.yml`, environment `release`, "Allow npm publish" on (a new configuration otherwise only
      allows staged publishing), for example
      `npm trust github @vibest/cli --file release-beta.yml --repo vibest-dev/vibest --env release --allow-publish`.
      Each package.json `repository.url` is `git+https://github.com/vibest-dev/vibest.git`, which provenance requires.
- [ ] Once a release has published with OIDC: revoke any npm token that could publish these packages.
- [ ] npm 11.5.1 or later in the publish job (Node 26.13.0 ships 11.20.0; the job checks it), Node 22.14.0 or later.
- [ ] No deploy key, no `RELEASE_PUSH_KEY` secret and no DeployKey bypass on "CI required on main": the workflow never
      pushes to `main`.

Status: in force.
