#!/bin/sh
# Install vibest: curl -fsSL https://github.com/iamdin/vibest/releases/latest/download/install.sh | sh
#
# Each version unpacks into its own directory, ~/.local/share/vibest/versions/<version>/ (bin/vibest, the harness
# plugins, and herdr-plugin/ beside them; herdr-plugin is not linked), and ~/.local/bin/vibest links to the newest. A running vibestd and its sessions keep the version they
# started from; the one before the newest is kept for them, older ones are removed. Nothing outside these paths is written.
#   VIBEST_DOWNLOAD_URL  where the archives are (default: the latest GitHub release)
#   VIBEST_INSTALL       instead of ~/.local/share/vibest
#   VIBEST_BIN           instead of ~/.local/bin (remembered for later installs and `vibest update`)
set -eu

url=${VIBEST_DOWNLOAD_URL:-https://github.com/iamdin/vibest/releases/latest/download}
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

# Keep this version and the one installed before it.
previous=$(cat "$share/current" 2>/dev/null || true)
printf '%s\n' "$version" > "$share/current"
for old in "$share/versions"/*; do
  name=$(basename "$old")
  [ "$name" = "$version" ] || [ "$name" = "$previous" ] || rm -rf "$old"
done

echo "vibest $version installed: $bin/vibest"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to run vibest." ;;
esac
