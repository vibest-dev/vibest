# Release

1. A release is one run of the Release workflow (`.github/workflows/release-beta.yml`), started on `main` from the
   Actions page or with `gh workflow run release-beta.yml -R vibest-dev/vibest --ref main -f version=<prerelease, patch,
   minor, major, an exact version, or canary>`. It bumps every package version, commits and tags `v<version>` in its own
   checkout, runs every gate on that commit (build, typecheck and lint, format, unit tests, the packed tarballs on Linux
   and macOS, and the install and E2E checks of tools/verify that its runner can run), then waits for the owner's
   approval (environment `release`). Only after the approval does it push the commit to `main` and the tag, publish
   exactly the tested tarballs to npm and make the GitHub Release. There is no local release or publish path: nobody
   bumps, tags or publishes from a machine.
2. Agents may prepare a release (the changelog, fixes) and start a run when the owner asks, and may run it with
   `-f dry_run=true` (every gate, then stop: nothing pushed or published) on any branch. Agents never approve the
   `release` environment, push version commits or `v*` tags, or publish to npm themselves.
3. Only the owner's runs do anything: every job checks that the owner started the run and the attempt; anyone else's
   run is skipped. A run that is not a dry run or a canary must be on `main`.
4. The root `bump` script and the workflow's Version step list the same package.json files; a package added to one goes
   into the other.
5. The run's E2E checks are only those its runner can run (it has no herdr, hc or harness CLIs). The rest are proved by
   an agent running the whole `pnpm verify` on that `main` commit before the release is started.

Status: in force.
