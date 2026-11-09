# @vibest/cursor: the vibest Cursor CLI plugin

vibest's integration for [Cursor's CLI](https://cursor.com/cli) (`cursor-agent`):

- **the tool guard**: before each tool call of a vibest agent, `vibest integration guard --harness cursor` asks vibestd
  (`Integration.Guard`), which runs the guard rules and answers in Cursor's shape (the `cursor` definition's
  `guardAnswer`); it refuses an agent driving herdr itself or reading the project store's files directly. It runs
  fail-closed.
- **readiness**: `sessionStart` goes to `vibest integration ready --harness cursor`; vibestd types the first task only
  after it.
- **a turn at work**: `afterAgentThought`, `postToolUse` and `beforeSubmitPrompt` go to
  `vibest integration prompt --harness cursor`; vibestd shows the session working, and opens a round for a prompt the
  user typed. Cursor runs a plugin's `beforeSubmitPrompt` only when user or project hooks also have one.
- **the turn end**: `afterAgentResponse` goes to `vibest integration stop --harness cursor`; vibestd writes the session's
  result and shows it idle. Cursor does not run a plugin's `stop` hook.

A report that does not reach vibestd fails its hook (never blocking the turn) and appends the error to
`$VIBEST_HOME/vibestd.log`. Nothing is written to the terminal.

Outside a vibest agent (no `VIBEST_AGENT` in the environment) the hooks do nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/cursor`, written by its build from
`src/plugin.ts`), and vibest starts each Cursor session with `cursor-agent --plugin-dir <that directory>`: loaded for that
session only, beside your own hooks and plugins. Your `~/.cursor` is not changed.

The hooks run the vibest that started the session (`VIBEST_COMMAND`).
