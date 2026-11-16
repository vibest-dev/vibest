# @vibest/agy: the vibest Antigravity CLI plugin

vibest's integration for the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`): a workspace plugin that agy
loads from the install's `harnesses/agy` folder, which vibest adds to each session with `--add-dir`.
`.agents/plugins/vibest/` holds `plugin.json`, `hooks.json`, `hook.sh` and the builtin skills.

- **the conversation and the execution start**: `SessionStart` (after the first input) and `PreInvocation` (before each
  model call) go to `vibest integration prompt --harness agy`; vibestd records the conversation id it resumes with
  `agy --conversation` and shows the session working.
- **the execution end**: `Stop` goes to `vibest integration stop --harness agy`; the execution completes, or fails with
  agy's `error`. agy's `Stop` carries no answer, so there is no reply text: `vibest peek` shows it.
- **the tool guard**: `PreToolUse` goes to `vibest integration guard --harness agy`; vibestd answers in agy's shape and
  a refused call does not run. When `vibest` fails, `hook.sh` answers `deny` itself.
- **agy's own subagents** run their own conversations in the same process and fire the same hooks; only the first
  conversation the process reports goes to vibestd.

vibest writes nothing to the terminal for agy and passes no `--settings`. Your `~/.gemini` and agy's settings and
credentials are not read or changed by vibest.

## Limits (agy 1.5.9)

- Esc fires no `Stop`: on herdr the execution is recorded `lost` after the pane is idle for 10 s; on herdr-core it stays
  open until the next `Stop` or `vibest interrupt`.
- The guard is fail-open where agy is: a hook agy cannot start, or one past its 30 s timeout, is skipped and the tool
  runs, with nothing else asking first (`--dangerously-skip-permissions`).
- The added folder shows in agy's workspace list, and the agent can read it.

Outside a vibest agent (no `VIBEST_SESSION_ID`) the hooks report nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/agy`, written by its build from `src/plugin.ts`).
`harnesses/agy/index.js` provides the harness; add the folder to `plugins` in `~/.vibest/vibest.json`, like Cursor's.
To start agy through a wrapper such as agyx, add a plugin of your own that sets the definition's `binary` to the wrapper;
vibest does not assume the binary is named `agy`.
