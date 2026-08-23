#!/usr/bin/env bash
# One-time setup for the vibest self-hosted CI runner (rn-vibest-01).
#
# Creates persistent pnpm / Turborepo cache directories beside the Actions
# _work tree so jobs skip actions/cache tarball round-trips. Optionally installs
# mise so Code check can skip downloading it on every run.
#
# Run on the runner host as root:
#   curl -fsSL …/bootstrap-ci-runner.sh | bash
# or copy this file and:
#   sudo bash bootstrap-ci-runner.sh /opt/actions-runner
set -euo pipefail

RUNNER_ROOT="${1:-/opt/actions-runner}"
CACHE_ROOT="${RUNNER_ROOT}/_work/.vibest-ci-cache"
RUNNER_USER="$(stat -c '%U' "${RUNNER_ROOT}/bin/Runner.Listener")"

mkdir -p "${CACHE_ROOT}/pnpm-store" "${CACHE_ROOT}/turbo"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${CACHE_ROOT}"

if ! command -v mise >/dev/null; then
  curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
fi

# Warm toolchain when the repo is already checked out on the runner.
REPO_DIR="${RUNNER_ROOT}/_work/vibest/vibest"
if [[ ! -f "${REPO_DIR}/mise.toml" ]]; then
  REPO_DIR="$(find "${RUNNER_ROOT}/_work" -path '*/vibest/mise.toml' -print -quit 2>/dev/null || true)"
  REPO_DIR="${REPO_DIR%/mise.toml}"
fi
if [[ -n "${REPO_DIR}" && -f "${REPO_DIR}/mise.toml" ]]; then
  sudo -u "${RUNNER_USER}" bash -lc "cd '${REPO_DIR}' && mise install --locked"
fi

printf 'Cache root: %s\n' "${CACHE_ROOT}"
printf 'Runner user: %s\n' "${RUNNER_USER}"
printf 'Done. Re-run after mise.toml / mise.lock changes to refresh tools.\n'
