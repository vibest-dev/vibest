# @vibest/cursor: the vibest Cursor CLI plugin

vibest's integration for [Cursor's CLI](https://cursor.com/cli) (`cursor-agent`):

- **the tool guard**: before each tool call of a vibest agent, `vibest integration guard --harness cursor` asks vibestd
  (`Integration.Guard`), which runs the guard rules and answers in Cursor's shape (the `cursor` definition's
  `guardAnswer`); it refuses an agent driving herdr itself or reading the project store's files directly. It runs
  fail-closed.
- **readiness**: `sessionStart` goes both to `vibest integration prompt --harness cursor`, which records the session's
  conversation id, and to `vibest integration ready --harness cursor` (Cursor runs the two at once). A starting Cursor
  takes its first message in its launch argv (after `--`), so no start waits for a ready report; a message to a running
  Cursor is typed once the runtime shows it settled (herdr), or at once (herdr-core, which shows no state for Cursor).
- **an execution at work**: `afterAgentThought`, `postToolUse` and `beforeSubmitPrompt` go to
  `vibest integration prompt --harness cursor`; vibestd shows the session working, and opens an execution for a prompt the
  user typed. Cursor runs a plugin's `beforeSubmitPrompt` only when user or project hooks also have one.
- **the execution end**: `afterAgentResponse` goes to `vibest integration stop --harness cursor`; vibestd writes the session's
  result and shows it idle. Cursor does not run a plugin's `stop` hook.

- **typed messages**: Cursor cannot take messages through its hooks, so vibestd types them, and empties the input box
  with `ctrl+u` right before each one. Text you left in the box unsent is cleared, as is a prompt Cursor drew back
  after an interrupt.

## Limits (cursor-agent 2026.11.13)

- Results come only from `afterAgentResponse`. An execution Cursor ends without a response (an error, Ctrl+C) sends
  nothing: on herdr vibestd records it `lost` once the pane is idle for 10 s; on herdr-core it stays open until the next
  response or `vibest interrupt`.
- A prompt you type in the pane is seen from its first thought or tool call, not when you submit it, and its text is not
  recorded.
- No permission, question or login wait is reported, so a Cursor session is never shown blocked on herdr-core. Sessions
  start with `--force`, so Cursor's own approval dialog does not hold them; vibest's guard still refuses what vibest
  forbids.
- A draft you leave in a vibest session's input box is cleared when vibest types the next message there.
- On herdr-core, after you stop your own prompt with Ctrl+C before Cursor answers, its execution stays open, so a
  queued message waits until the next response or `vibest interrupt`.

A report that does not reach vibestd fails its hook (never blocking the execution) and appends the error to
`$VIBEST_HOME/vibestd.log`. Nothing is written to the terminal.

Outside a vibest agent (no `VIBEST_SESSION_ID` in the environment) the hooks do nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/cursor`, written by its build from
`src/plugin.ts`), and vibest starts each Cursor session with `cursor-agent --plugin-dir <that directory>`: loaded for that
session only, beside your own hooks and plugins. Your `~/.cursor` is not changed.

The hooks run the vibest that started the session (`VIBEST_COMMAND`).
