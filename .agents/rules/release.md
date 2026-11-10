# Release

1. A release is one run of the Release workflow (`.github/workflows/release-beta.yml`), started on `main` from the
   Actions page or with `gh workflow run release-beta.yml -R vibest-dev/vibest --ref main -f version=<prerelease, patch,
   minor, major, an exact version, or canary>`. It bumps every package version, commits and tags `v<version>` in its own
   checkout, runs the release gate on that commit (the whole of `pnpm verify --no-cache`, the single entry for all
   verification, on GitHub-hosted runners: `ubuntu-latest` runs it with `--elsewhere H4`, and `macos-latest` runs
   `pnpm verify --no-cache H4`, the macOS-only check, on the same commit), packs the tarballs and checks them on Linux
   and macOS, then waits for the owner's approval (environment `release`). Only after the approval does it push the
   commit to `main` and the tag, publish exactly the tested tarballs to npm and make the GitHub Release, whose notes
   are the CHANGELOG.md section of that version when there is one, otherwise GitHub's generated notes. There is no
   local release or publish path: nobody bumps, tags or publishes from a machine.
2. Agents may prepare a release (the changelog, fixes) and start a run when the owner asks, and may run it with
   `-f dry_run=true` (every gate, then stop: nothing pushed or published) on any branch. Agents never approve the
   `release` environment, push version commits or `v*` tags, or publish to npm themselves.
3. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run or a canary must be on `main`.
4. The root `bump` script and the workflow's Version step list the same package.json files; a package added to one goes
   into the other.
5. The gate is `pnpm verify` as it is: the workflow does not replace any part of it with other commands. A part the
   runner cannot run fails the run; fix the runner or verify, never narrow the gate.

Status: in force.
