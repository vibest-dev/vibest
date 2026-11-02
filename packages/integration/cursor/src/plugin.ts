// @vibest/cursor: the Cursor CLI plugin, as files. vibest writes them into its own home and starts cursor-agent with
// `--plugin-dir <that directory>`; nothing is installed into Cursor. scripts/build.ts writes the same files for npm.
// Facts from cursor-agent 2026.10.22: a plugin directory's `hooks/hooks.json` runs like ~/.cursor/hooks.json, with the
// plugin root as the hook's working directory; `afterAgentResponse` carries the reply as `text`, `stop` only a status.
import pkg from "../package.json" with { type: "json" }

/** The hook script: only a vibest agent (VIBEST_AGENT, set in the pane vibest starts) is checked or reported. */
export const HOOK = `#!/bin/sh
# @vibest/cursor ${pkg.version}: \`vibest integration guard\` before a tool call, \`vibest integration prompt\` when the user submits, \`vibest integration stop\` at a turn end.
case "\${1:-}" in
  guard)
    # preToolUse runs fail-closed, where no answer refuses: outside vibest, allow (it grants no approval).
    if [ -z "\${VIBEST_AGENT:-}" ]; then cat >/dev/null; echo '{"permission":"allow"}'; exit 0; fi
    vibest integration guard --harness cursor || { echo "vibest integration guard failed; the tool call is refused." >&2; exit 2; }
    ;;
  prompt)
    # beforeSubmitPrompt can block the prompt. A missed report must not: the turn still runs.
    if [ -z "\${VIBEST_AGENT:-}" ] || [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; exit 0; fi
    vibest integration prompt --harness cursor >/dev/null 2>&1 || true
    ;;
  stop)
    if [ -z "\${VIBEST_AGENT:-}" ] || [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; exit 0; fi
    vibest integration stop --harness cursor >/dev/null 2>&1 || true
    ;;
esac
exit 0
`

const hook = (action: string) => ({ command: `sh ./hooks/vibest.sh ${action}` })

/** Every file of the plugin, by its path inside the plugin directory. */
export const files: Readonly<Record<string, string>> = {
  ".cursor-plugin/plugin.json": `${JSON.stringify({ name: "vibest", version: pkg.version, description: pkg.description }, null, 2)}\n`,
  "hooks/hooks.json": `${JSON.stringify(
    {
      version: 1,
      hooks: {
        // A crash, timeout or missing answer refuses the call; Cursor otherwise lets it through.
        preToolUse: [{ ...hook("guard"), failClosed: true }],
        beforeSubmitPrompt: [hook("prompt")],
        afterAgentResponse: [hook("stop")],
        stop: [hook("stop")],
      },
    },
    null,
    2,
  )}\n`,
  "hooks/vibest.sh": HOOK,
}
