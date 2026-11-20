import pkg from "../package.json" with { type: "json" }

export const HOOK = `#!/bin/sh
# @vibest/cursor ${pkg.version}: \`vibest integration guard\` before a tool call, \`prompt\` and \`ready\` at the session start, \`prompt\` when an execution starts or works, \`stop\` at its response.
# The vibest vibestd started this agent with (VIBEST_CLI), not the first vibest on PATH, which a login shell may reorder.
vibest() {
  command "\${VIBEST_CLI:-vibest}" "$@"
}
case "\${1:-}" in
  guard)
    # preToolUse runs fail-closed, where no answer refuses: outside vibest, allow (it grants no approval).
    if [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; echo '{"permission":"allow"}'; exit 0; fi
    vibest integration guard --harness cursor || { echo "vibest integration guard failed; the tool call is refused." >&2; exit 2; }
    ;;
  ready | prompt | stop)
    if [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; exit 0; fi
    vibest integration "$1" --harness cursor >/dev/null 2>>"\${VIBEST_HOME:-$HOME/.vibest}/vibestd.log" || exit 1
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
