# Release

1. A release is the owner running `pnpm release` (bumpp: bump every package version, commit, tag `v<version>`, push) in a checkout whose `origin` is `vibest-dev/vibest`. The `v*` tag starts the Release workflow (`.github/workflows/release-beta.yml`), which publishes to npm and makes the GitHub Release. There is no local publish path.
2. Agents never bump versions, create or push tags, publish to npm, or run the Release workflow (no `workflow_dispatch`, no rerun). The workflow runs only for the owner.
3. The `release` script and the workflow's Version step list the same package.json files; a package added to one goes into the other.

Status: in force.
