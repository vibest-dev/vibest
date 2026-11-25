import { PROTOCOL } from "@vibest/schema/version"

import pkg from "../package.json" with { type: "json" }

export const PLUGIN = ".agents/plugins/vibest"

export const HOOK = `#!/bin/sh
# @vibest/agy ${pkg.version}: posts hooks directly to vibest.sock.
sock="\${VIBEST_HOME:-$HOME/.vibest}/vibest.sock"
log="\${VIBEST_HOME:-$HOME/.vibest}/vibestd.log"
post() {
  route="$1"
  body="$2"
  tmp=$(mktemp "\${TMPDIR:-/tmp}/vibest-agy-hook.XXXXXX") || return 1
  trap 'rm -f "$tmp"' EXIT INT TERM
  for delay in 0.1 0.3 0.9 ""; do
    set -- -sS --max-time 5 --unix-socket "$sock" -o "$tmp" -w '%{http_code}' -X POST -H "content-type: text/plain" -H "vibest-protocol: ${PROTOCOL}" -H "vibest-caller: session" -H "vibest-plugin-version: ${pkg.version}" -H "vibest-session-id: $VIBEST_SESSION_ID" -H "vibest-project-id: $VIBEST_PROJECT_ID" -H "vibest-harness: agy"
    if [ -n "\${VIBEST_PROCESS:-}" ]; then
      set -- "$@" -H "vibest-process: $VIBEST_PROCESS"
    fi
    code=$(printf '%s' "$body" | curl "$@" --data-binary @- "http://vibest$route" 2>/dev/null)
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
      cat "$tmp"
      rm -f "$tmp"
      return 0
    fi
    if [ "$rc" -eq 7 ] || [ "$code" = "503" ]; then
      if [ -n "$delay" ]; then
        sleep "$delay"
        continue
      fi
    fi
    printf '%s vibest: agy %s of session %s did not reach vibestd (curl=%s http=%s): %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$route" "$VIBEST_SESSION_ID" "$rc" "\${code:-000}" "$(cat "$tmp" 2>/dev/null)" >>"$log"
    rm -f "$tmp"
    return 1
  done
}
# Hooks carry no subagent marker: the first conversation this process reports is its own; agy's subagents are not.
own_conversation() {
  conversation=$(printf '%s' "$input" | tr '\\n' ' ' | sed -n 's/.*"conversationId" *: *"\\([^"]*\\)".*/\\1/p')
  [ -n "$conversation" ] || return 1
  seen="\${TMPDIR:-/tmp}/vibest-agy-$VIBEST_SESSION_ID-$VIBEST_PROCESS"
  [ -s "$seen" ] || printf '%s' "$conversation" >"$seen"
  [ "$(cat "$seen")" = "$conversation" ]
}
case "\${1:-}" in
  guard)
    if [ -z "\${VIBEST_SESSION_ID:-}" ] || [ -z "\${VIBEST_PROJECT_ID:-}" ]; then cat >/dev/null; echo '{"decision":"allow"}'; exit 0; fi
    input=$(cat)
    # agy runs a tool whose hook fails or times out: a failed check answers deny itself.
    out=$(post /api/hook/agy/guard "$input")
    if [ $? -eq 0 ] && [ -n "$out" ]; then
      printf '%s\\n' "$out"
    else
      echo '{"decision":"deny","reason":"vibestd unreachable; the tool call is refused."}'
    fi
    ;;
  prompt)
    input=$(cat)
    if [ -n "\${VIBEST_SESSION_ID:-}" ] && [ -n "\${VIBEST_PROJECT_ID:-}" ] && own_conversation; then
      post /api/hook/agy/prompt "$input" >/dev/null
    fi
    echo '{}'
    ;;
  stop)
    input=$(cat)
    if [ -n "\${VIBEST_SESSION_ID:-}" ] && [ -n "\${VIBEST_PROJECT_ID:-}" ] && own_conversation; then
      post /api/hook/agy/execution-end "$input" >/dev/null
    fi
    echo '{"decision":"allow"}'
    ;;
esac
exit 0
`

const hook = (action: string) => [{ type: "command", command: `sh ./hook.sh ${action}`, timeout: 30 }]

export const files = {
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
} satisfies Readonly<Record<string, string>>
