#!/bin/sh
set -eu
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
DESKTOP=$ROOT/apps/desktop
VIBEST=$ROOT/apps/vibest-herdr/dist/vibest
APP=$DESKTOP/build/vibest-desktop
MARK=.vibest-desktop-demo

die() { echo "demo: $*" >&2; exit 1; }

world() {
	DIR=$1
	SESSION=vibest-demo
	WORLD_PATH="$DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

run() {
	exec env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color SHELL=/bin/zsh \
		TMPDIR="$DIR/tmp" PATH="$WORLD_PATH" ZDOTDIR="$DIR/zdotdir" \
		HC_SESSION="$SESSION" HC_SOCKET="$DIR/hc.sock" \
		XDG_STATE_HOME="$DIR/state" XDG_CONFIG_HOME="$DIR/config" XDG_RUNTIME_DIR="$DIR/run" \
		VIBEST_HOME="$DIR/vibest" PI_CODING_AGENT_DIR="$DIR/pi" \
		VIBEST_DESKTOP_CONFIG_DIR="$DIR/desktop/config" VIBEST_DESKTOP_STATE_DIR="$DIR/desktop/state" \
		"$@"
}

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

stop_pid() {
	pid=$(cat "$1" 2>/dev/null || true)
	if alive "$pid"; then
		kill "$pid" 2>/dev/null || true
		i=0
		while alive "$pid" && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
		alive "$pid" && kill -9 "$pid" 2>/dev/null || true
	fi
	return 0
}

start() {
	[ -x "$VIBEST" ] || die "no $VIBEST; run pnpm build first"
	[ -x "$APP" ] || make -C "$DESKTOP" build >/dev/null
	hc=$(command -v hc) || die "hc (herdr-core) is not on PATH"
	pi=$(command -v pi) || die "pi is not on PATH"
	bun=$(command -v bun) || die "bun is not on PATH"
	world "$(mktemp -d /tmp/vibest-demo.XXXXXX)"
	touch "$DIR/$MARK"
	mkdir -p "$DIR/bin" "$DIR/tmp" "$DIR/zdotdir" "$DIR/state" "$DIR/config" "$DIR/run" "$DIR/vibest" "$DIR/pi" "$DIR/desktop/config" "$DIR/desktop/state"
	chmod 700 "$DIR/run"
	printf '#!/bin/sh\nexec "%s" "$@"\n' "$VIBEST" >"$DIR/bin/vibest"
	chmod +x "$DIR/bin/vibest"
	ln -s "$hc" "$DIR/bin/hc"
	ln -s "$pi" "$DIR/bin/pi"
	ln -s "$bun" "$DIR/bin/bun"

	run bun "$DESKTOP/scripts/demo-model.ts" >"$DIR/model.url" 2>"$DIR/model.log" &
	echo $! >"$DIR/model.pid"
	i=0
	while [ ! -s "$DIR/model.url" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
	url=$(cat "$DIR/model.url")
	[ -n "$url" ] || die "the fake model did not start; see $DIR/model.log"
	printf '{"providers":{"fake":{"baseUrl":"%s","apiKey":"fake","api":"openai-completions","models":[{"id":"m","contextWindow":100000,"maxTokens":1000}]}}}\n' "$url" >"$DIR/pi/models.json"
	printf '{"defaultProvider":"fake","defaultModel":"m"}\n' >"$DIR/pi/settings.json"

	mkdir -p "$DIR/project"
	git -C "$DIR/project" init -q -b main
	git -C "$DIR/project" -c user.name=demo -c user.email=demo@invalid commit -q --allow-empty -m init

	run "$APP" -core-socket "$DIR/hc.sock" -core-session "$SESSION" >"$DIR/app.log" 2>&1 &
	echo $! >"$DIR/app.pid"
	i=0
	while [ ! -S "$DIR/hc.sock" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
	[ -S "$DIR/hc.sock" ] || die "the app did not start herdr-core; see $DIR/app.log"

	printf '{"runtime":"hc"}\n' >"$DIR/vibest/vibest.json"
	(run vibest daemon) >"$DIR/vibestd.out" 2>&1 || die "vibest daemon failed; see $DIR/vibestd.out"

	cat <<EOF
Demo world: $DIR
  project:  $DIR/project
  in the app: open the folder above (sidebar +), start its main agent, click it, type "delegate" and Enter
  hc ls:    $0 hc $DIR ls --all
  teardown: $0 stop $DIR
EOF
}

check() {
	[ -n "${1:-}" ] || die "usage: $0 stop|hc DIR"
	case $1 in /tmp/vibest-demo.*) ;; *) die "$1 is not a demo world" ;; esac
	[ -f "$1/$MARK" ] || die "$1 is not a demo world"
	world "$1"
}

stop() {
	check "${1:-}"
	stop_pid "$DIR/app.pid"
	daemon=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/vibest/vibestd.pid" 2>/dev/null || true)
	echo "$daemon" >"$DIR/vibestd.pid.plain"
	stop_pid "$DIR/vibestd.pid.plain"
	(run hc server stop) >/dev/null 2>&1 || true
	stop_pid "$DIR/model.pid"
	rm -rf "$DIR"
	echo "removed $DIR"
}

case ${1:-start} in
start) start ;;
stop) shift; stop "$@" ;;
hc)
	shift
	check "${1:-}"
	shift
	run hc "$@"
	;;
*) die "usage: $0 [start] | stop DIR | hc DIR ARGS..." ;;
esac
