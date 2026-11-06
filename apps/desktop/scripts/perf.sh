#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
WORK=${TMPDIR:-/tmp}/vibest-desktop-perf
mkdir -p "$WORK"
rm -f "$WORK/config/window-state.json" "$WORK/state/vibest-desktop/window-state.json"
APP=${1:-$WORK/reherdr}
if [ $# -eq 0 ]; then
	sh scripts/patch-mygo.sh
	go build -o "$APP" ./cmd/reherdr
fi
printf '[terminal]\ndefault_shell = "/bin/sh"\n\n[ui.sound]\nenabled = false\n' >"$WORK/config.toml"
unset HERDR_BIN_PATH HERDR_ENV HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_TAB_ID HERDR_WORKSPACE_ID
export HERDR_SESSION=mygo-perf HERDR_CONFIG_PATH="$WORK/config.toml" XDG_STATE_HOME="$WORK/state"
herdr session delete mygo-perf >/dev/null 2>&1 || true

herdr server >"$WORK/herdr.log" 2>&1 &
srv=$! pid=
trap 'set +e; kill $pid 2>/dev/null; sleep 1; herdr session stop mygo-perf >/dev/null 2>&1; kill $srv 2>/dev/null; wait $srv; herdr session delete mygo-perf >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
for i in 1 2 3 4 5 6 7 8 9 10; do
	herdr status server 2>/dev/null | grep -q 'status: running' && break
	sleep 0.5
done
for try in 1 2; do
	VIBEST_DESKTOP_CONFIG_DIR="$WORK/config" VIBEST_DESKTOP_STATE_DIR="$WORK/state/vibest-desktop" "$APP" -session mygo-perf >"$WORK/app.log" 2>&1 &
	pid=$!
	sleep 6
	kill -0 "$pid" 2>/dev/null && break
done

mem() {
	footprint -p "$1" | awk '
		function mb(n, u) { return u=="MB" ? n : u=="KB" ? n/1024 : u=="GB" ? n*1024 : 0 }
		/Footprint:/ { for (i = 1; i <= NF; i++) if ($i == "Footprint:") total = mb($(i+1), $(i+2)) }
		/graphics\)/ { gpu += mb($1, $2) }
		/IOSurface/ { frames += mb($1, $2) }
		/MALLOC_|untagged/ { heap += mb($1, $2) }
		END { printf "%.0f %.0f %.0f %.0f", total, gpu, frames, heap }'
}
fp() {
	set -- "$1" $(mem "$pid") $(mem "$srv" | cut -d" " -f1)
	printf '%-30s app %4s MB (textures %3s, frames %2s, heap %2s)  herdr %3s MB\n' "$@"
}
cpu() { ps -o time= -p "$1" | awk -F'[:.]' '{ printf "%.2f", $1*60 + $2 + $3/100 }'; }
pct() { awk -v a="$1" -v b="$2" -v s="$3" 'BEGIN { printf "%.1f%%", (b-a)*100/s }'; }
during() {
	a0=$(cpu "$pid") h0=$(cpu "$srv")
	sleep "$2"
	echo "$1: cpu app $(pct "$a0" "$(cpu "$pid")" "$2"), herdr $(pct "$h0" "$(cpu "$srv")" "$2")"
	fp "  then"
}

fp "idle"
p=$(herdr pane list | jq -r '.result.panes[0].pane_id')
herdr pane split "$p" --direction right >/dev/null
herdr pane split "$p" --direction down >/dev/null
sleep 2
stream='i=0; while [ $i -lt 500 ]; do echo "streaming line $i of agent output text"; sleep 0.02; i=$((i+1)); done'
tui='clear; printf "\033[?1049h"; i=0; while [ $i -lt 330 ]; do printf "\033[?2026h\033[H"; j=0; while [ $j -lt 30 ]; do printf "row %s frame %s  ⠋ thinking\033[K\n" $j $i; j=$((j+1)); done; printf "\033[?2026l"; sleep 0.03; i=$((i+1)); done; printf "\033[?1049l"'
herdr pane run "$p" "$stream" >/dev/null
during "3 panes, one streaming" 10
herdr pane run "$p" "$tui" >/dev/null
during "agent TUI redrawing" 10
sleep 1
set -- $(herdr pane list | jq -r '.result.panes[].pane_id')
herdr pane run "$1" "$tui" >/dev/null
herdr pane run "$2" "$stream" >/dev/null
herdr pane run "$3" "$stream" >/dev/null
during "3 panes at once" 10

ws=$(herdr workspace list | jq -r '.result.workspaces[0].workspace_id')
for i in 1 2 3; do herdr tab create --workspace "$ws" >/dev/null; done
tabs=$(herdr tab list | jq -r '.result.tabs[].tab_id')
for t in $tabs; do
	herdr tab focus "$t" >/dev/null
	q=$(herdr pane list | jq -r --arg t "$t" '[.result.panes[] | select(.tab_id==$t)][0].pane_id')
	[ "$(herdr pane list | jq --arg t "$t" '[.result.panes[] | select(.tab_id==$t)] | length')" -gt 1 ] || {
		herdr pane split "$q" --direction right >/dev/null
		herdr pane split "$q" --direction down >/dev/null
	}
	sleep 0.5
done
for round in 1 2 3 4 5 6 7 8 9 10; do
	for t in $tabs; do herdr tab focus "$t" >/dev/null; sleep 0.3; done
done
fp "after 40 switches of 4 tabs"
sleep 15
fp "15 s idle"
