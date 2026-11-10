# Release

1. A release has two steps, and neither pushes to `main` outside a pull request:
   - **The release pull request.** On a new branch from `main`, `pnpm bump --release <prerelease, patch, minor, major or
     an exact version>` sets every package version and commits only that change ("chore: release v<version>"; no tag,
     no push). Add the CHANGELOG.md section for the version (`## <version>`) when there is one, push the branch and open
     the pull request. It merges like any change: through CI's required check, by the owner or the coordinator.
   - **The Release workflow** (`.github/workflows/release-beta.yml`), started by the owner on `main` from the Actions
     page or with `gh workflow run release-beta.yml -R vibest-dev/vibest --ref main`. It releases main's version as it
     is: it fails when `v<version>` tags another commit, or is untagged while `@vibest/cli@<version>` is already on
     npm, runs the release gate on main's commit (the whole of `pnpm verify --no-cache`, the single entry for all
     verification, on GitHub-hosted runners: `ubuntu-latest` runs it with `--elsewhere H4`, and `macos-latest` runs
     `pnpm verify --no-cache H4`, the macOS-only check, on the same commit), packs the tarballs and checks them on Linux
     and macOS, then waits for the owner's approval (environment `release`). Only after the approval does it tag that
     commit `v<version>` (with `GITHUB_TOKEN`), publish exactly the tested tarballs to npm and make the GitHub Release,
     whose notes are the CHANGELOG.md section of that version when there is one, otherwise GitHub's generated notes.
     A release that stopped partway is finished by running the workflow again on the same commit: it keeps a tag already
     on that commit, skips each package already on npm with the same tarball integrity, and skips an existing GitHub
     Release; a tag on another commit or a different tarball fails the run.
     There is no local release or publish path: nobody tags or publishes from a machine.
2. Agents may prepare a release (the release pull request, the changelog, fixes) and start a run when the owner asks,
   and may run it with `-f dry_run=true` (every gate, then stop: nothing tagged or published) on any branch; a dry run
   only warns when the version is already released. `-f canary=true` publishes `<version>-canary.<time>.g<sha>` to npm
   under `canary` from any branch: no tag, no GitHub Release. Agents never approve the `release` environment, push `v*`
   tags, or publish to npm themselves.
3. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run or a canary must be on `main`.
4. The root `bump` script and the workflow's Version step list the same package.json files; a package added to one goes
   into the other.
5. The gate is `pnpm verify` as it is: the workflow does not replace any part of it with other commands. A part the
   runner cannot run fails the run; fix the runner or verify, never narrow the gate.

Status: in force.
