# Integrations and the guard

vibest's plugin for each harness ships with vibest and is loaded into every session vibest starts; nothing is
installed into the harness's own configuration. Its pre-tool guard runs `session.tool.execute.before` plugin hooks, with
`vibest.guard` enforcing minimal protocol invariants. Each capability below
says what it is and when it counts as working.

## I1. The plugins ship with vibest

Each harness's plugin is part of the vibest install, and there is nothing to install; hooks talk directly to vibestd over its Unix sockets.

## I2. The binary finds its embedded plugins

The compiled vibest binary embeds all harness plugins and `herdr-plugin/` inside itself and materializes them to `<VIBEST_HOME>/cache/assets/<version>-<hash>/` on daemon startup, so a standalone copied binary runs `vibest doctor` cleanly without `VIBEST_HARNESSES` or a sibling `harnesses/` folder. When `VIBEST_HARNESSES` is explicitly pointed at a missing directory, `vibest doctor` refuses each harness and names the missing plugin directory.

## I3. Pi runs vibest's extension

A real Pi session started by vibest runs vibest's extension (reporting, guard and inbox; the TUI presentation is a separate extension loaded beside it): a command refused by `vibest.guard` (such as `curl --unix-socket "$VIBEST_HOME/vibest-http.sock" ...`) does not run and returns the guard's reason, and the agent's reply is the execution's reply.

## I4. Claude runs vibest's plugin beside the user's plugins

A real Claude session started by vibest runs vibest's plugin beside plugins installed in its configuration: an
installed plugin's session-start hook runs too, and the reply is the execution's reply.

## I5. Cursor runs vibest's plugin beside the project's hooks

A real cursor-agent session on the user's own login runs vibest's plugin beside the project's own hooks. Asked to run
a direct `curl --unix-socket` request to `vibest-http.sock`, it does not run (the model either tries and `vibest.guard` refuses it, or keeps to its rules); the execution
completes with the reply, and the project's own hook ran.

## I6. The user's harness configuration is untouched

Running agents through vibest never changes the user's own harness configuration files, and leaves no herdr session
behind.

## I7. Every Claude execution end reaches vibest

Every end of a Claude main-loop execution reaches vibest: an answer is a completed execution; the person pressing Esc in the
pane gives exactly one interrupted execution and no notice, the same as `vibest interrupt`, whose aborted execution's end reaches
vibest too, also while a background shell keeps the terminal busy.

## I9. Claude's guard without settings

Claude starts without a settings file; vibest's plugin guards each tool call instead. Commands refused by `vibest.guard` (`VIBEST_SESSION_ID=other vibest ls`, `curl --unix-socket "$VIBEST_HOME/vibest-http.sock" ...`) are refused with the guard's reason and do not run, while ordinary commands (`hc --version`) and reading in its own Project folder are allowed.

## I10. Cursor reports to vibestd

A real cursor-agent on the user's login reports to vibestd on herdr and on herdr-core: its first task is in its launch
argv, `vibest ls` shows it working during an execution and idle after it, `vibest result` carries
the reply, a message sent while the user's unsent text sits in its input box clears that text and is delivered, `vibest
interrupt` ends the execution as interrupted with no notice (also when it lands right after vibest typed a message, and
the next message is then delivered alone), and the plugin never writes to the terminal.

Checks `I10-herdr` and `I10-hc` (tier `agent`) script this on the user's Cursor login, and record which hook events
Cursor dispatched and its screen in each input-box state.

Known limits, from Cursor itself: results come only from its response, so an execution it ends without one (an error,
Ctrl+C) is `lost` on herdr and stays open on herdr-core until the next response or `vibest interrupt`; it never shows
as blocked on herdr-core.

## I11. Another vibest first on PATH

When another `vibest` comes first on PATH, even when the pane's login shell puts it first again (as fnm does), the
integrations still reach the vibest that started them: a Pi entry session reports ready, Pi and Claude subagents deliver
their messages, an entry session restarts, and the other vibest never runs. A plain `vibest` an agent types reaches the
same vibest: every session starts with `VIBEST_CLI` set to it and its directory first on PATH.

## I12. Cursor never waits on its own approval dialog

A Cursor session vibest started runs shell commands without Cursor asking "Run this command?", even on Cursor's default
`allowlist` approval mode with no allow rule: its `vibest send` to the session that started it arrives, and the session
is never blocked. vibest's guard still refuses what `vibest.guard` forbids: asked to run a direct `curl --unix-socket` request to `vibest-http.sock`, it does not run.

## I13. A Cursor session resumes from its start

A Cursor session's conversation is recorded when Cursor starts it, before any reply. If its pane is closed before a
first reply, `vibest send` reopens it on that conversation and the reply arrives; closed again after a reply, the next
`vibest send` resumes it too.

## I14. A Cursor entry session takes messages

With Cursor as the entry session (`vibest --harness cursor`), on herdr and on herdr-core, a message sent to it while it
is idle with an empty input box is typed into Cursor and answered as an execution of the entry session. A message sent
while the user's unsent text sits in the box clears that text and is typed and answered alone. A message sent while Cursor works on a prompt the user typed in its pane is typed
only after that work ends, and each reply is on its own execution.

Checks `I14-herdr` and `I14-hc` (tier `agent`) script this on the user's Cursor login.

## R6. Pi's guard

Pi applies the same guard rules inside vibest's extension.

## R7. Claude's hooks reach vibest

In a running Claude, the plugin's tool-call guard and its execution-end report both reach vibest.

## R8. Pi and Cursor ask vibestd

Pi and Cursor ask vibestd to judge each tool call, and get its deny or allow answer.
