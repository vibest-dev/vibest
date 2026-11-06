#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ROOT=$PWD
DIR=third_party/mygo
STAMP=.reherdr-patched
. patches/mygo/BASE

die() { echo "patch-mygo: $*" >&2; exit 1; }
sum() { shasum -a 256 | cut -d' ' -f1; }
tree() { (cd "$1" && find . -type f ! -name "$STAMP" -exec shasum -a 256 {} + | LC_ALL=C sort -k2 | sum); }

grep -q "^[[:space:]]*$MODULE $VERSION\$" go.mod || die "go.mod does not require $MODULE $VERSION, the version of patches/mygo/BASE"
grep -q "^replace $MODULE => ./$DIR\$" go.mod || die "go.mod does not replace $MODULE with ./$DIR"
set -- patches/mygo/*.patch
[ -f "$1" ] || die "no patches in patches/mygo"
inputs=$({ echo "$MODULE@$VERSION $SUM"; cat "$@"; } | sum)

mkdir -p "$(dirname "$DIR")"
LOCK=$ROOT/third_party/.mygo.lock
tmp=
trap 'rm -rf "$tmp"; [ ! -f "$LOCK/pid.$$" ] || rm -rf "$LOCK"' EXIT
waited=0
until mkdir "$LOCK" 2>/dev/null; do
	holder=$(cd "$LOCK" 2>/dev/null && ls pid.* 2>/dev/null | sed -n 's/^pid\.//p' | head -n 1) || holder=
	if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
		rm "$LOCK/pid.$holder" 2>/dev/null && rmdir "$LOCK" 2>/dev/null
		continue
	fi
	[ $waited -lt 6000 ] || die "$LOCK is held by process ${holder:-unknown}; remove it if no preparation is running"
	sleep 0.1
	waited=$((waited + 1))
done
: >"$LOCK/pid.$$"

old=
[ ! -L "$DIR" ] || die "$DIR is a symlink; move it away"
if [ -e "$DIR" ]; then
	links=$(find "$DIR" -type l -print)
	[ -z "$links" ] || die "$DIR contains symlinks; move them away"
	[ -f "$DIR/$STAMP" ] || die "$DIR was not made by this script; move it away"
	read -r was made <"$DIR/$STAMP"
	[ "$(tree "$DIR")" = "$made" ] || die "$DIR has edits of its own; make them a patch in patches/mygo, or move $DIR away"
	if [ "$was" = "$inputs" ]; then
		echo "$DIR is up to date"
		exit 0
	fi
	old=$DIR
fi

tmp=$(mktemp -d "$ROOT/third_party/.mygo.XXXXXX")
echo 'module patch-mygo-download' >"$tmp/go.mod"
json=$(cd "$tmp" && GOFLAGS= GOWORK=off go mod download -json "$MODULE@$VERSION") || die "cannot download $MODULE@$VERSION"
src=$(printf '%s\n' "$json" | sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p')
got=$(printf '%s\n' "$json" | sed -n 's/^[[:space:]]*"Sum": "\(.*\)",$/\1/p')
[ "$got" = "$SUM" ] || die "$MODULE@$VERSION has checksum $got, not $SUM of patches/mygo/BASE"
[ -f "$src/go.mod" ] || die "no source for $MODULE@$VERSION"

cp -R "$src" "$tmp/src"
chmod -R u+w "$tmp/src"
for p; do
	GIT_CEILING_DIRECTORIES=$tmp git -C "$tmp/src" apply --whitespace=nowarn "$ROOT/$p" ||
		die "$p does not apply to $MODULE@$VERSION"
done
echo "$inputs $(tree "$tmp/src")" >"$tmp/src/$STAMP"

if [ -n "$old" ]; then
	mv "$old" "$tmp/old"
fi
if ! mv "$tmp/src" "$DIR"; then
	if [ -n "$old" ] && ! mv "$tmp/old" "$DIR"; then
		trap - EXIT
		die "cannot restore $DIR; previous tree kept at $tmp/old; move it back to $ROOT/$DIR before retrying"
	fi
	die "cannot install $DIR"
fi
echo "made $DIR: $MODULE@$VERSION with $# patches"
