import pkg from "../package.json" with { type: "json" }

export const STATUS = `#!/bin/sh
# @vibest/agy ${pkg.version}: agy runs this as its session-only status line. Its state goes to the terminal as OSC 7501, its conversation id to \`vibest integration prompt\`.
vibest() {
  case "\${VIBEST_COMMAND:-}" in
    *'\\'*) ;;
    '["'*'"]')
      words=$(printf '%s' "$VIBEST_COMMAND" | sed -e 's/^\\["//' -e 's/"\\]$//' -e 's/","/\\
/g')
      ifs=$IFS
      IFS='
'
      set -f
      set -- $words "$@"
      IFS=$ifs
      set +f
      "$@"
      return
      ;;
  esac
  command vibest "$@"
}
input=$(cat | tr '\\n' ' ')
field() { printf '%s' "$input" | sed -n "s/.*\\"$1\\" *: *\\"\\([^\\"]*\\)\\".*/\\1/p"; }
state=$(field agent_state)
conversation=$(field conversation_id)
case "$input" in
  *'"tool_confirmation_pending": true'* | *'"tool_confirmation_pending":true'*) state=permission ;;
esac
case "$state" in
  working | tool_use) report=working ;;
  permission) report=blocked:kind=permission ;;
  authenticating) report=blocked:kind=auth ;;
  reviewing) report=blocked ;;
  idle) report=idle ;;
  error) report=error ;;
  *) report= ;;
esac
if [ -n "$report" ]; then printf '\\033]7501;state=%s\\033\\\\' "$report" 2>/dev/null >/dev/tty || :; fi
if [ -n "$conversation" ] && [ -n "\${VIBEST_SESSION_ID:-}" ]; then
  seen="\${TMPDIR:-/tmp}/vibest-agy-$VIBEST_SESSION_ID-\${VIBEST_PROCESS:-0}"
  if [ "$(cat "$seen" 2>/dev/null)" != "$conversation" ]; then
    printf '%s' "$input" | vibest integration prompt --harness agy >/dev/null 2>>"\${VIBEST_HOME:-$HOME/.vibest}/vibestd.log" &&
      printf '%s' "$conversation" >"$seen"
  fi
fi
exit 0
`

export const files: Readonly<Record<string, string>> = { "status.sh": STATUS }
