# @vibest/agy: the vibest Antigravity CLI plugin

vibest's integration for the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`). agy loads no plugin for one
session, so vibest launches it with a session-only `--settings` that sets a status line (`status.sh`); agy runs that
command on every state change and pipes its state as JSON to it.

- **state**: the agent state goes to the terminal as OSC 7501 (`working`, `idle`, `blocked` for a permission dialog,
  `blocked:kind=auth` while signing in, `error`), which herdr-core keeps as the terminal's status. A herdr that detects
  agy by its screen needs no such report and ignores it.
- **the conversation id**: the first non-empty `conversation_id` goes to `vibest integration prompt --harness agy`, which is
  how vibestd learns what to resume with `agy --conversation`.

The status line prints nothing; it stacks on agy's own. Your `~/.gemini` and agy's settings are not read or changed, and
a status line of your own is not shown in a vibest session.

Outside a vibest agent (no `VIBEST_SESSION_ID`) it reports nothing to vibestd.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/agy`, written by its build from `src/plugin.ts`).
`harnesses/agy/plugin.js` provides the harness; add it to `plugins` in `~/.vibest/vibest.json`, like Cursor's.
To start agy through a wrapper such as agyx, add a plugin of your own that sets the definition's `binary` to the wrapper;
vibest does not assume the binary is named `agy`.
