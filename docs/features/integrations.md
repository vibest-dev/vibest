# Integrations and the guard

vibest's plugin for each harness ships with vibest and is loaded into every session vibest starts; nothing is
installed into the harness's own configuration. Its pre-tool guard keeps an agent to its role. Each capability below
says what it is and when it counts as working.

## I1. The plugins ship with vibest

Each harness's plugin is part of the vibest install, and `vibest integration` offers only the hooks the plugins call
(guard, prompt, stop, ready, start); there is nothing to install.

## I2. The binary finds its plugins

The vibest binary finds the plugins installed beside it. A vibest with no plugins beside it cannot run a harness, and
`vibest doctor` names the missing plugin directory for each harness.

## I3. Pi runs vibest's extension

A real Pi session started by vibest runs vibest's extension: a herdr command the agent tries is refused with the
guard's reason and does not run, and the agent's reply is the turn's answer.

## I4. Claude runs vibest's plugin beside the user's plugins

A real Claude session started by vibest runs vibest's plugin beside plugins installed in its configuration: an
installed plugin's session-start hook runs too, and the reply is the turn's answer.

## I5. Cursor runs vibest's plugin beside the project's hooks

A real cursor-agent session on the user's own login runs vibest's plugin beside the project's own hooks. Asked to run a
herdr command, herdr does not run (the model either tries and the guard refuses it, or keeps to its rules); the turn
completes, its answer carries the reply, and the project's own hook ran.

## I6. The user's harness configuration is untouched

Running agents through vibest never changes the user's own harness configuration files, and leaves no herdr session
behind.

## I7. Every Claude turn end reaches vibest

Every end of a Claude main-loop turn reaches vibest: an answer is a completed turn; the person pressing Esc in the
pane gives exactly one failed turn and one notice saying the turn was stopped in its terminal; after `vibest interrupt` the aborted
turn's end reaches vibest and gives an interrupted turn and no notice, also while a background shell keeps the terminal busy.

## I9. Claude's guard without settings

Claude starts without a settings file; vibest's plugin guards each tool call instead. A herdr command, and reading,
finding or searching in another Project's folder, are each refused with the guard's reason, no refused file's text
reaches the model, and reading in its own Project folder is allowed.

## I10. Cursor reports to vibestd

A real cursor-agent on the user's login reports to vibestd on herdr and on herdr-core: its first task is typed only
after its plugin reported ready, `vibest ls` shows it working during a turn and idle after it, `vibest result` carries
the reply, `vibest interrupt` ends the turn as interrupted with no notice, and the plugin never writes to the
terminal.

## I11. Another vibest first on PATH

When another `vibest` comes first on PATH, the integrations still reach the vibest that started them: a Pi main agent
reports ready, Pi and Claude subagents deliver their messages, a main agent restarts, and the other vibest never runs.

## R6. Pi's guard

Pi applies the same guard rules inside vibest's extension.

## R7. Claude's hooks reach vibest

In a running Claude, the plugin's tool-call guard and its turn-end report both reach vibest.

## R8. Pi and Cursor ask vibestd

Pi and Cursor ask vibestd to judge each tool call, and get its deny or allow answer.
