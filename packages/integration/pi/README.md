# @vibest/pi: the vibest Pi extension

Implementation notes for the Pi [harness adapter](../../../docs/design/architecture.md#8-harness-adapters).

`pi -e <dir>/extension.mjs` loads `src/extension.ts` bundled with everything it imports except
Pi's own packages, which Pi resolves for the extensions it loads. With `VIBEST_SESSION_ID` it
serves the session (inbox rows taken in process and delivered as custom messages the model sees and the TUI hides: an
execution starts when Pi is idle, else they queue as follow-ups; execution starts and ends are sent); without it it does
nothing. Tool calls go through the session's agent definition in vibestd. Only the TUI session
is the harness's root session: print, RPC and JSON modes have no PTY, so a Pi child of a session, which inherits
`VIBEST_SESSION_ID`, takes no rows, reports nothing and does not change the TUI. Pi calls the extension factory once per
session and awaits it, then awaits `session_shutdown`; the extension is built in a scope that lives as long as the
session, its handlers registered before `session_start`, and `session_shutdown` (kept outside that scope) closes it.
The extension never starts vibestd: during `vibest daemon restart` the replacement may be between sockets. The inbox
stream is subscribed again when the connection drops or vibestd closes it (rows not yet taken stay pending); anything
else ends it with a notice to the user. A send that got no answer is unknown, not failed: vibestd may still apply it,
and keeps the newest conversation id either way (the last report wins). A TUI `session_start` for `new`, `resume` or
`fork` reports its conversation id before another execution; `agent_end` reports the first startup id. Pi 1.1.0 warns and
recreates the id of an empty `/new` that has no file yet. Only the entry session gets the `delegate` and `pipeline` skills.
Its `before_agent_start` clears the prompt sections other coding-agent extensions add; Pi runs those handlers in load
order, so only extensions loaded before this one are cleared, and executions started by inbox rows skip that event.
The entry session's `--system-prompt` replaces Pi's coding-assistant preamble (Pi still adds context files, skills and
cwd), and its `--tools` is an exact allowlist, not +/- entries on the defaults: those keep every extension's tools,
and a user's delegation extension (pi-subagents' `subagent`) would then win over `vibest run`. A user prompt is Pi's
`input` event, except source `extension`, which is vibest's own deliveries. Pi refuses `--provider` without
`--model`, so a login chosen without a model is dropped and Pi starts on its own default (a known ceiling: pick that
provider's default model when quota routing on Pi matters).

The entry session's Pi TUI groups adjacent tool rows (thinking does not split a group; user text, assistant text or a
displayed custom message does; image results stay outside) and compacts user messages. Pi's values are read
defensively, as their shapes differ across versions. A custom message sent with `triggerTurn: false` during a run is
appended outside the agent loop and reaches no `message_start`, so the extension observes the session's
`appendCustomMessageEntry` and restores it on release. With two copies of the extension loaded, the later copy's
renderers are marked and used alone, so a group gets one header; the original renderer still runs on every update,
hidden, so its timers and redraws keep working. The user-message patch of Pi's shared prototypes is one lease that
lives on `UserMessageComponent.prototype` while its wrappers are installed: overlapping instances of the same module
share it, a lease from another module evaluation (after `/reload`) is never joined, the lease is published before any
wrapper, and an install refuses when the prototypes' methods changed since this instance first saw them.
