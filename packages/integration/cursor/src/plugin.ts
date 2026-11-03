// @vibest/cursor: the Cursor CLI plugin, as files. vibest writes them into its own home and starts cursor-agent with
// `--plugin-dir <that directory>`; nothing is installed into Cursor. scripts/build.ts writes the same files for npm.
// Facts from cursor-agent 2026.10.22: a plugin directory's `hooks/hooks.json` runs like ~/.cursor/hooks.json, with the
// plugin root as the hook's working directory; `afterAgentResponse` carries the reply as `text`, `stop` only a status.
import pkg from "../package.json" with { type: "json" }

/**
 * The hook script: only a vibest agent (VIBEST_AGENT and VIBEST_SESSION_ID, set in the pane vibest starts) is checked or
 * reported. Every hook's raw payload goes to `vibest integration event`; vibestd decodes it with the cursor adapter.
 */
export const HOOK = `#!/bin/sh
# @vibest/cursor ${pkg.version}: each hook's payload to \`vibest integration event --harness cursor <hook>\`.
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
case "\${1:-}" in
  preToolUse)
    # preToolUse runs fail-closed, where no answer refuses: outside vibest, allow (it grants no approval).
    if [ -z "\${VIBEST_AGENT:-}" ]; then cat >/dev/null; echo '{"permission":"allow"}'; exit 0; fi
    vibest integration event --harness cursor preToolUse || { echo "vibest integration event failed; the tool call is refused." >&2; exit 2; }
    ;;
  *)
    # A missed report must not block the prompt or fail the turn.
    if [ -z "\${VIBEST_AGENT:-}" ] || [ -z "\${VIBEST_SESSION_ID:-}" ]; then cat >/dev/null; exit 0; fi
    vibest integration event --harness cursor "$1" >/dev/null 2>&1 || true
    ;;
esac
exit 0
`

const hook = (name: string) => ({ command: `sh ./hooks/vibest.sh ${name}` })

/** Every file of the plugin, by its path inside the plugin directory. */
export const files: Readonly<Record<string, string>> = {
  ".cursor-plugin/plugin.json": `${JSON.stringify({ name: "vibest", version: pkg.version, description: pkg.description }, null, 2)}\n`,
  "hooks/hooks.json": `${JSON.stringify(
    {
      version: 1,
      hooks: {
        // A crash, timeout or missing answer refuses the call; Cursor otherwise lets it through.
        preToolUse: [{ ...hook("preToolUse"), failClosed: true }],
        beforeSubmitPrompt: [hook("beforeSubmitPrompt")],
        afterAgentResponse: [hook("afterAgentResponse")],
        stop: [hook("stop")],
      },
    },
    null,
    2,
  )}\n`,
  "hooks/vibest.sh": HOOK,
}
