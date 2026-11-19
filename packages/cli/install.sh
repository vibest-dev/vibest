#!/bin/sh
# Install vibest: curl -fsSL https://github.com/vibest-dev/vibest/releases/latest/download/install.sh | sh
# The newest stable release; with --beta (sh -s -- --beta), the newest release of either channel, beta or stable.
#
# Each version unpacks into its own directory, ~/.local/share/vibest/versions/<version>/ (bin/vibest, the harness
# plugins, and herdr-plugin/ beside them; herdr-plugin is not linked), and ~/.local/bin/vibest links to the newest. A running vibestd and its sessions keep the version they
# started from; the one before the newest and any a running process still uses are kept, older ones are removed. Nothing
# outside these paths is written.
#   VIBEST_DOWNLOAD_URL  the archives of one release, installed whatever the channel
#   VIBEST_RELEASES_URL  where the releases are listed (default: https://github.com/vibest-dev/vibest/releases)
#   VIBEST_INSTALL       instead of ~/.local/share/vibest
#   VIBEST_BIN           instead of ~/.local/bin (remembered for later installs and `vibest update`)
set -eu

channel=stable
for arg in "$@"; do
  case "$arg" in
    --beta) channel=beta ;;
    *) echo "vibest: unknown option $arg (install.sh takes only --beta)" >&2; exit 1 ;;
  esac
done

# The newest of the release versions on stdin (x.y.z and x.y.z-beta.n; a release sorts after its betas).
newest() {
  sed -n -e 's/^\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)$/\1 \2 \3 1 0 &/p' \
    -e 's/^\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)-beta\.\([0-9][0-9]*\)$/\1 \2 \3 0 \4 &/p' \
    | sort -n -k1,1 -k2,2 -k3,3 -k4,4 -k5,5 | tail -n 1 | cut -d' ' -f6
}

if [ -n "${VIBEST_DOWNLOAD_URL:-}" ]; then
  url=$VIBEST_DOWNLOAD_URL
else
  releases=${VIBEST_RELEASES_URL:-https://github.com/vibest-dev/vibest/releases}
  releases=${releases%/}
  if [ "$channel" = stable ]; then
    # GitHub's Latest release is the newest stable: betas are prereleases.
    release=$(curl -fsSL "$releases/latest/download/version" 2>/dev/null | grep -x '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' || true)
    if [ -z "$release" ]; then
      echo "vibest: there is no stable release yet ($releases/latest/download/version names none); for the newest beta: curl -fsSL $releases/latest/download/install.sh | sh -s -- --beta" >&2
      exit 1
    fi
  else
    release=$(curl -fsSL "$releases.atom" | grep -o '/releases/tag/v[^"<[:space:]]*' | sed 's#.*/tag/v##' | newest)
    if [ -z "$release" ]; then echo "vibest: $releases.atom lists no release" >&2; exit 1; fi
  fi
  url=$releases/download/v$release
fi
share=${VIBEST_INSTALL:-$HOME/.local/share/vibest}
# The link directory an earlier install used, so `vibest update` (which sets only VIBEST_INSTALL) keeps it.
bin=${VIBEST_BIN:-$(cat "$share/bin" 2>/dev/null || echo "$HOME/.local/bin")}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  *) echo "vibest: no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$share/versions" "$bin"
tmp=$(mktemp -d "$share/versions/.download.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url/vibest-$target.tar.gz" | tar -xzf - -C "$tmp"
version=$("$tmp/bin/vibest" --version | sed 's/^vibest v//')
case "$version" in ''|*/*|.*) echo "vibest: the downloaded binary reports no version" >&2; exit 1 ;; esac

dir="$share/versions/$version"
if [ ! -d "$dir" ]; then mv "$tmp" "$dir"; fi
# Replace the link in one step: a vibest started meanwhile runs the old version or the new one, never neither.
ln -sfn "$dir/bin/vibest" "$bin/.vibest.new"
mv -f "$bin/.vibest.new" "$bin/vibest"

printf '%s\n' "$bin" > "$share/bin"

# Keep this version, the one installed before it, and any a running process still uses: vibestd runs its bin/vibest, and
# each agent loaded its harness plugin from there (a deleted --plugin-dir unloads Claude's hooks).
# ponytail: processes of this machine only; agents on a remote machine are not seen.
previous=$(cat "$share/current" 2>/dev/null || true)
printf '%s\n' "$version" > "$share/current"
running=$(ps -A -o args= 2>/dev/null || true)
for old in "$share/versions"/*; do
  name=$(basename "$old")
  [ "$name" = "$version" ] || [ "$name" = "$previous" ] && continue
  case "$running" in *"$old/"*) continue ;; esac
  rm -rf "$old"
done

echo "vibest $version installed: $bin/vibest"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to run vibest." ;;
esac
