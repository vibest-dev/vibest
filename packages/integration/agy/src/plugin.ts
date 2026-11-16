import pkg from "../package.json" with { type: "json" }

export const PLUGIN = ".agents/plugins/vibest"

export const HOOK = `#!/bin/sh
# @vibest/agy ${pkg.version}: \`vibest integration guard\` before a tool call, \`prompt\` at a conversation's start and before each model call, \`stop\` at its end.
# The vibest vibestd started this agent with (VIBEST_COMMAND, a JSON argv), not the first vibest on PATH. A value this
# cannot read safely (not a JSON array of plain strings: a backslash in it) falls back to PATH.
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
log="\${VIBEST_HOME:-$HOME/.vibest}/vibestd.log"
# Hooks carry no subagent marker: the first conversation this process reports is its own; agy's subagents are not.
own_conversation() {
  conversation=$(printf '%s' "$input" | tr '\\n' ' ' | sed -n 's/.*"conversationId" *: *"\\([^"]*\\)".*/\\1/p')
  [ -n "$conversation" ] || return 1
  seen="\${TMPDIR:-/tmp}/vibest-agy-$VIBEST_SESSION_ID-\${VIBEST_PROCESS:-0}"
  [ -s "$seen" ] || printf '%s' "$conversation" >"$seen"
  [ "$(cat "$seen")" = "$conversation" ]
}
case "\${1:-}" in
  guard)
    if [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; echo '{"decision":"allow"}'; exit 0; fi
    # agy runs a tool whose hook fails or times out: a failed check answers deny itself.
    vibest integration guard --harness agy 2>>"$log" ||
      echo '{"decision":"deny","reason":"vibest integration guard failed; the tool call is refused."}'
    ;;
  prompt | stop)
    input=$(cat)
    if [ -n "\${VIBEST_SESSION_ID:-}" ] && own_conversation; then
      printf '%s' "$input" | vibest integration "$1" --harness agy >/dev/null 2>>"$log"
    fi
    if [ "$1" = stop ]; then echo '{"decision":"allow"}'; else echo '{}'; fi
    ;;
esac
exit 0
`

const hook = (action: string) => [{ type: "command", command: `sh ./hook.sh ${action}`, timeout: 30 }]

export const files: Readonly<Record<string, string>> = {
  [`${PLUGIN}/plugin.json`]: `${JSON.stringify({ name: "vibest", version: pkg.version, description: pkg.description }, null, 2)}\n`,
  [`${PLUGIN}/hooks.json`]: `${JSON.stringify(
    {
      vibest: {
        enabled: true,
        SessionStart: hook("prompt"),
        PreInvocation: hook("prompt"),
        Stop: hook("stop"),
        PreToolUse: [{ matcher: "", hooks: hook("guard") }],
      },
    },
    null,
    2,
  )}\n`,
  [`${PLUGIN}/hook.sh`]: HOOK,
}
