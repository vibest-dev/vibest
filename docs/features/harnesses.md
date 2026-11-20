# Harnesses and models

The coding agents (harnesses) vibest runs: Claude, Pi, Cursor and Antigravity (agy) all come with vibest. Each capability below says what it is and when it
counts as working.

## H1. Listing harnesses

`vibest harness list` shows one entry per loaded harness (Claude, Pi, Cursor and agy) with its binary, whether it can start, and its
default model. A harness whose CLI is missing says so. `--machine <name>` lists another machine's harnesses (see
[machines.md](machines.md) M9). The list is the whole machine's; the default model is the harness's global default, which a repository's
own harness settings may change in its project, and vibest does not read them.

## H2. Listing models

`vibest harness models <harness>` and `vibest models` list a non-empty set of models for each installed harness; a
harness that is not installed is left out.

## H3. Doctor

`vibest doctor` groups what it checks (coding agents, herdr, vibestd, plugins), puts a line saying how to fix each
problem under it, and ends with a verdict: one line per harness, and a herdr line for each harness that can run.

## H4. Cursor probes on a home without a login keychain

On macOS, vibest never starts Cursor to discover models or read its usage when the home has no login keychain, and it
does not carry SSH session settings into a home it switches to.

## H5. A run inherits the caller's harness

`vibest run` without a harness takes the caller's harness, provider and model: from the session that runs it. Naming a
harness drops the provider and model. With nothing to inherit and nothing choosing a harness (the builtin default removed
with `"-vibest.harness-default"`, or Claude not available, and no plugin picking one), it fails saying there is no harness to
inherit; otherwise the default applies (H7).

## H6. `vibest` reuses the entry session's last harness

`vibest` without `--harness` starts the harness the project's entry session last used. A project's first start without
`--harness` runs on Claude when Claude is available, and fails asking for `--harness` when it is not or when
`"-vibest.harness-default"` is in `vibest.json`'s `plugins`.

Entering a project checks only that a harness can start there (its binary on `PATH`, vibest's plugin folder for it) and
lists no models, so it waits on no harness CLI; a harness that is installed but cannot answer (for example signed out)
is offered and fails when it starts. vibest never checks whether a harness is signed in and never signs one in: an
entry session opened on a signed-out harness shows that harness's own login screen, and a `vibest run` agent that never
becomes ready fails saying the harness may be signed out and to sign in with its binary.

## H7. The default harness is Claude

A project's first bare `vibest` without `--harness` starts its entry session on Claude when Claude is available. A user
plugin that picks another harness wins over the default. When Claude cannot start the start fails saying there is no
harness to inherit.

## H8. Every shipped harness is loaded

Claude, Pi, Cursor and agy are loaded without any line in `~/.vibest/vibest.json`, and `vibest harness list` lists
each. Whether this machine can start one is checked only when it is asked for: a harness whose binary is not on
`PATH` is listed as unavailable saying so, and vibestd starts as usual. `"-vibest.harness-cursor"` (or another
`-vibest.harness-<id>`) in `plugins` removes one.

## H9. Antigravity (agy)

`agy` appears in `vibest harness list` and its models in `vibest models`, read from the agy CLI without a model turn.
`vibest subscriptions` has no agy data: vibest runs no background usage probe for agy, because agy's print mode starts
an interactive OAuth in the browser when it is signed out. vibest never reads agy's own config or credential files and never
signs in.
The definition's `binary` can be pointed at a wrapper such as `agyx` by a plugin of the user's own; nothing assumes it is
named `agy`.

## H10. An agy session runs on its reports

`vibest run agy -- <task>` starts agy with the task after the system prompt; the session records agy's conversation id from
its `SessionStart`, and the execution completes at agy's `Stop` (no reply text: `vibest peek` shows the answer). A
`vibest send` while it is idle is the next execution. When its pane closes, the next send resumes the same conversation
with `agy --conversation`.

## H11. agy runs on herdr-core

On herdr-core, which has no state for agy, a session vibest starts takes its first message in its launch argv (`agy
--prompt-interactive`) and completes it at `Stop`; a message sent when it is idle again is typed and completes; after
its terminal is gone, a message resumes the same conversation with that message in the argv.

## H12. An agy entry session takes messages

With agy as the entry session (`vibest --harness agy`) on herdr, a message sent while it is idle is typed into agy and
completes as an execution of the entry session. A draft the user left in its input box is cleared before a message is
typed, and the message arrives alone. A prompt the user types in the pane opens an execution at agy's first model call;
a message sent while it works waits for its `Stop`.

## H14. vibest's guard checks agy's tool calls

A tool call of an agy session that vibest's guard refuses (a herdr command, another project's folder) does not run, and
the session goes on. Ceiling: agy runs the tool when the hook cannot start or passes its timeout.

## H13. agy loads vibest's plugin for the session only

An agy session vibest starts loads vibest's hooks and skills from the install's `harnesses/agy` folder (added with
`--add-dir`); nothing is installed in agy, agy's settings are not read or changed, and vibest sets no status line and no
title.
