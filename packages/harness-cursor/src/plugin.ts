import { PROTOCOL } from "@vibest/schema/version"

import pkg from "../package.json" with { type: "json" }

export const HOOK = `#!/bin/sh
# @vibest/cursor ${pkg.version}: posts hooks directly to vibest.sock.
sock="\${VIBEST_HOME:-$HOME/.vibest}/vibest.sock"
log="\${VIBEST_HOME:-$HOME/.vibest}/vibestd.log"
post() {
  route="$1"
  body="$2"
  ctype="\${3:-text/plain}"
  tmp=$(mktemp "\${TMPDIR:-/tmp}/vibest-cursor-hook.XXXXXX") || return 1
  trap 'rm -f "$tmp"' EXIT INT TERM
  for delay in 0.1 0.3 0.9 ""; do
    set -- -sS --max-time 5 --unix-socket "$sock" -o "$tmp" -w '%{http_code}' -X POST -H "content-type: $ctype" -H "vibest-protocol: ${PROTOCOL}" -H "vibest-caller: session" -H "vibest-plugin-version: ${pkg.version}" -H "vibest-session-id: $VIBEST_SESSION_ID" -H "vibest-project-id: $VIBEST_PROJECT_ID" -H "vibest-harness: cursor"
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
    printf '%s vibest: cursor %s of session %s did not reach vibestd (curl=%s http=%s): %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$route" "$VIBEST_SESSION_ID" "$rc" "\${code:-000}" "$(cat "$tmp" 2>/dev/null)" >>"$log"
    rm -f "$tmp"
    return 1
  done
}
case "\${1:-}" in
  guard)
    # preToolUse runs fail-closed, where no answer refuses: outside vibest, allow (it grants no approval).
    if [ -z "\${VIBEST_SESSION_ID:-}" ] || [ -z "\${VIBEST_PROJECT_ID:-}" ]; then cat >/dev/null; echo '{"permission":"allow"}'; exit 0; fi
    input=$(cat)
    out=$(post /api/hook/cursor/guard "$input")
    if [ $? -eq 0 ] && [ -n "$out" ]; then
      printf '%s\\n' "$out"
      exit 0
    fi
    echo "vibest guard failed; the tool call is refused." >&2
    exit 2
    ;;
  prompt)
    if [ -z "\${VIBEST_SESSION_ID:-}" ] || [ -z "\${VIBEST_PROJECT_ID:-}" ]; then cat >/dev/null; exit 0; fi
    input=$(cat)
    post /api/hook/cursor/prompt "$input" >/dev/null || exit 1
    ;;
  stop)
    if [ -z "\${VIBEST_SESSION_ID:-}" ] || [ -z "\${VIBEST_PROJECT_ID:-}" ]; then cat >/dev/null; exit 0; fi
    input=$(cat)
    post /api/hook/cursor/execution-end "$input" >/dev/null || exit 1
    ;;
  ready)
    if [ -z "\${VIBEST_SESSION_ID:-}" ] || [ -z "\${VIBEST_PROJECT_ID:-}" ]; then cat >/dev/null; exit 0; fi
    cat >/dev/null
    post /api/hook/ready '{}' 'application/json' >/dev/null || exit 1
    ;;
esac
exit 0
`

const hook = (action: string) => ({ command: `sh ./hooks/vibest.sh ${action}` })

export const files = {
  ".cursor-plugin/plugin.json": `${JSON.stringify({ name: "vibest", version: pkg.version, description: pkg.description }, null, 2)}\n`,
  "hooks/hooks.json": `${JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [hook("prompt"), hook("ready")],
        preToolUse: [{ ...hook("guard"), failClosed: true }],
        beforeSubmitPrompt: [hook("prompt")],
        afterAgentThought: [hook("prompt")],
        postToolUse: [hook("prompt")],
        afterAgentResponse: [hook("stop")],
      },
    },
    null,
    2,
  )}\n`,
  "hooks/vibest.sh": HOOK,
} satisfies Readonly<Record<string, string>>
