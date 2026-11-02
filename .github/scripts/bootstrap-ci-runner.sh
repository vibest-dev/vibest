#!/usr/bin/env bash
# One-time setup for the vibest self-hosted CI runner (rn-vibest-01).
#
# Creates persistent pnpm store and Turborepo cache directories beside the Actions
# _work tree, so jobs skip actions/cache tarball round-trips. The workflows'
# "Prepare persistent CI caches" step creates them too; this sets their owner.
#
# Run on the runner host as root:
#   sudo bash bootstrap-ci-runner.sh /opt/actions-runner
set -euo pipefail

RUNNER_ROOT="${1:-/opt/actions-runner}"
CACHE_ROOT="${RUNNER_ROOT}/_work/.vibest-ci-cache"
RUNNER_USER="$(stat -c '%U' "${RUNNER_ROOT}/bin/Runner.Listener")"

mkdir -p "${CACHE_ROOT}/pnpm-store" "${CACHE_ROOT}/turbo"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${CACHE_ROOT}"

printf 'Cache root: %s\n' "${CACHE_ROOT}"
printf 'Runner user: %s\n' "${RUNNER_USER}"
