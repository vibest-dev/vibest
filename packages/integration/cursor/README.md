# @vibest/cursor: the vibest Cursor CLI plugin

vibest's integration for [Cursor's CLI](https://cursor.com/cli) (`cursor-agent`):

- **the tool guard**: before each tool call of a vibest agent, `vibest integration guard --harness cursor` decides; it
  refuses an agent driving herdr itself or reading the project store's files directly. It runs fail-closed.
- **a typed prompt**: `beforeSubmitPrompt` goes to `vibest integration prompt --harness cursor`, which opens a round
  when the user typed it. A failure does not block the prompt.
- **the turn end**: `afterAgentResponse` and `stop` go to `vibest integration stop --harness cursor`, which writes the
  session's result and tells vibestd.

Outside a vibest agent (no `VIBEST_AGENT` in the environment) the hooks do nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/cursor`, written by its build from
`src/plugin.ts`), and vibest starts each Cursor session with `cursor-agent --plugin-dir <that directory>`: loaded for that
session only, beside your own hooks and plugins. Your `~/.cursor` is not changed.

The hooks run `vibest` from `PATH`.
