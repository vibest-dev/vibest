# @vibest/cursor: the vibest Cursor CLI plugin

vibest's integration for [Cursor's CLI](https://cursor.com/cli) (`cursor-agent`):

Every hook sends its raw payload to `vibest integration event --harness cursor <hook>`; vibestd decodes it with the
cursor adapter (`packages/core/src/harnesses/cursor.ts`) into the neutral integration events.

- **the tool guard**: `preToolUse` gets vibestd's answer; it refuses an agent driving herdr itself or reading the
  project store's files directly. It runs fail-closed.
- **a typed prompt**: `beforeSubmitPrompt` is a typed turn start; vibestd opens a round. A failure does not block the
  prompt.
- **the turn end**: `afterAgentResponse` (the reply) and `stop` (a status other than completed) are turn ends; vibestd
  writes the session's result. Every hook's `conversation_id` is the session's conversation.

Outside a vibest agent (no `VIBEST_AGENT` in the environment) the hooks do nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/cursor`, written by its build from
`src/plugin.ts`), and vibest starts each Cursor session with `cursor-agent --plugin-dir <that directory>`: loaded for that
session only, beside your own hooks and plugins. Your `~/.cursor` is not changed.

The hooks run `vibest` from `PATH`.
