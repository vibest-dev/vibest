# @vibest/agy: the vibest Antigravity CLI plugin

vibest's integration for the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`): a workspace plugin that agy
loads from the install's `harnesses/agy` folder, which vibest adds to each session with `--add-dir`.
`.agents/plugins/vibest/` holds `plugin.json`, `hooks.json`, `hook.sh` and the builtin skills.

- **the conversation and the execution start**: `SessionStart` (after the first input) and `PreInvocation` (before each
  model call) post to `POST /api/hook/agy/prompt` on `$VIBEST_HOME/vibest.sock`; vibestd records the conversation id it resumes with
  `agy --conversation` and shows the session working.
- **the execution end**: `Stop` posts to `POST /api/hook/agy/execution-end`; the execution completes, or fails with
  agy's `error`. agy's `Stop` carries no answer, so there is no reply text: `vibest peek` shows it.
- **the tool guard**: `PreToolUse` posts to `POST /api/hook/agy/guard`; vibestd answers in agy's shape and
  a refused call does not run. When vibestd is unreachable, `hook.sh` answers `deny` itself.
- **the first message**: a process vibest starts (a new session, or a resume after its terminal is gone) gets its first
  message as `agy --prompt-interactive <message>`, so agy takes it once it is ready itself: herdr-core has no state for
  agy that could say so. While it waits, vibest's startup step accepts agy's folder trust dialog.
- **typed messages**: later messages are typed into agy, and empties the input box first (`ctrl+e`, then `ctrl+u` 40
  times): a draft you left there unsent is cleared.
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
- Each new folder a session runs in (every worktree) is added to the profile's `trustedWorkspaces` by agy itself when
  vibest accepts its trust dialog; the list grows by one entry per session, and vibest never reads or cleans it.
- On herdr-core nothing shows agy blocked (sign-in, a plan waiting for approval), and an execution ended by Esc stays
  open until the next `Stop` or `vibest interrupt`.
- Usage: vibest has no agy usage data (it never runs agy's print mode, which opens a browser sign-in when agy is
  signed out); a session that hits a model's limit ends at its `Stop` with agy's error.

Outside a vibest agent (no `VIBEST_SESSION_ID`) the hooks report nothing.

## Use

Nothing to install. The plugin ships inside `@vibest/cli` (`harnesses/agy`, written by its build from `src/plugin.ts`).
vibest loads the agy harness by default.
To start agy through a wrapper such as agyx, add a plugin of your own that sets the definition's `binary` to the wrapper;
vibest does not assume the binary is named `agy`.
