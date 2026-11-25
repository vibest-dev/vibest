#!/bin/sh
# Install vibest: curl -fsSL https://github.com/vibest-dev/vibest/releases/latest/download/install.sh | sh
# The newest stable release; with --beta (sh -s -- --beta), the newest release of either channel, beta or stable.
#
# Each version unpacks into its own directory, ~/.local/share/vibest/versions/<version>/ (a single self-contained
# bin/vibest binary that extracts harness plugins and herdr-plugin/ into ~/.vibest/cache/assets/<version>-<hash>/ on
# daemon startup), and ~/.local/bin/vibest links to the newest. A running vibestd and its sessions keep the version they
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

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "vibest: no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) cpu=arm64 ;;
  x86_64|amd64)
    if [ "$os" = "darwin" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      cpu=arm64
    else
      cpu=x64
    fi
    ;;
  *) echo "vibest: no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

abi=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
    abi="-musl"
  fi
fi

target="${os}-${cpu}${abi}"

mkdir -p "$share/versions" "$bin"
tmp=$(mktemp -d "$share/versions/.download.XXXXXX")
trap 'rm -rf "$tmp"; rm -f "$bin/.vibest.new"' EXIT
curl -fsSL "$url/vibest-$target.tar.gz" | tar -xzf - -C "$tmp"
version=$("$tmp/bin/vibest" --version | sed 's/^vibest v//')
case "$version" in ''|*/*|.*) echo "vibest: the downloaded binary reports no version" >&2; exit 1 ;; esac

dir="$share/versions/$version"
# A version directory is never changed once it exists; one that differs from this download (files missing or changed;
# files a harness added are fine) is refused, so nothing links to a copy that was not checked.
if [ -d "$dir" ]; then
  if diff -r "$tmp" "$dir" 2>&1 | grep -v -F "Only in $dir" | grep -q .; then
    echo "vibest: $dir differs from the $version download; nothing was changed (remove it and install again)" >&2
    exit 1
  fi
else
  mv "$tmp" "$dir"
fi

# The new link is prepared, then the records written, then the link replaced: until that last step, a failure leaves the
# old install as it was.
ln -sfn "$dir/bin/vibest" "$bin/.vibest.new"
previous=$(cat "$share/current" 2>/dev/null || true)
linked=$(readlink "$bin/vibest" 2>/dev/null || true)
printf '%s\n' "$bin" > "$share/bin"
printf '%s\n' "$version" > "$share/current"
# Replace the link in one step: a vibest started meanwhile runs the old version or the new one, never neither.
if ! mv -f "$bin/.vibest.new" "$bin/vibest"; then
  printf '%s\n' "$previous" > "$share/current"
  echo "vibest: could not replace $bin/vibest; it is unchanged" >&2
  exit 1
fi
if [ "$("$bin/vibest" --version 2>/dev/null)" != "vibest v$version" ]; then
  printf '%s\n' "$previous" > "$share/current"
  if [ -n "$linked" ]; then
    ln -sfn "$linked" "$bin/vibest"
    echo "vibest: $bin/vibest did not run $version; it links to $linked again" >&2
  else
    rm -f "$bin/vibest"
    echo "vibest: $bin/vibest did not run $version and was removed" >&2
  fi
  exit 1
fi

# Keep this version, the one installed before it, and any a running process still uses: vibestd runs its bin/vibest, and
# each agent loaded its harness plugin from there (a deleted --plugin-dir unloads Claude's hooks).
# ponytail: processes of this machine only; agents on a remote machine are not seen.
running=$(ps -A -o args= 2>/dev/null || true)
for old in "$share/versions"/*; do
  name=$(basename "$old")
  [ "$name" = "$version" ] || [ "$name" = "$previous" ] && continue
  case "$running" in *"$old/"*) continue ;; esac
  rm -rf "$old" || true
done

echo "vibest $version installed: $bin/vibest"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to run vibest." ;;
esac
