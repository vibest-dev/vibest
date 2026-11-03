#!/bin/sh
# The only entrypoint of the vibest herdr plugin.
#   vibest.sh pane <entrypoint>   open one of this plugin's [[panes]] (an action cannot open a pane itself)
#   vibest.sh herdr <verb>        exec `vibest herdr <verb>`: startup, open-main, run, stop, runs, subscriptions, palette.
#                                 vibest reads HERDR_PLUGIN_CONTEXT_JSON itself (the Project directory is in there).
# VIBEST_BIN overrides the executable (plugin commands inherit the herdr server's environment).
set -eu
if [ "${1:-}" = pane ]; then
  exec "${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin "$HERDR_PLUGIN_ID" --entrypoint "$2" --focus
fi
exec "${VIBEST_BIN:-vibest}" "$@"
