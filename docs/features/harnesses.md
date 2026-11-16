# Harnesses and models

The coding agents (harnesses) vibest runs: Claude and Pi come with vibest, Cursor is a plugin you add. Each capability below says what it is and when it
counts as working.

## H1. Listing harnesses

`vibest harness list` shows one entry per loaded harness (Claude and Pi, and Cursor once its plugin is added) with its binary, whether it can start, and its
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

With the Cursor plugin added, on macOS, vibest never starts Cursor to discover models or read its usage when the home has no login keychain, and it
does not carry SSH session settings into a home it switches to.

## H5. A run inherits the caller's harness

`vibest run` without a harness takes the caller's harness, provider and model: from the session that runs it. Naming a
harness drops the provider and model. With nothing to inherit and nothing choosing a harness (the builtin default removed
with `"-harness-default"`, or Claude not available, and no plugin picking one), it fails saying there is no harness to
inherit; otherwise the default applies (H7).

## H6. `vibest` reuses the entry session's last harness

`vibest` without `--harness` starts the harness the project's entry session last used. A project's first start without
`--harness` runs on Claude when Claude is available, and fails asking for `--harness` when it is not or when
`"-harness-default"` is in `vibest.json`'s `plugins`.

## H7. The default harness is Claude

A project's first bare `vibest` without `--harness` starts its entry session on Claude when Claude is available. A user
plugin that picks another harness wins over the default. When Claude cannot start the start fails saying there is no
harness to inherit.

## H8. Cursor is a plugin

Cursor is not built in. `vibest run cursor` is refused saying no plugin provides it and where plugins are added; after
the shipped `harnesses/cursor` folder of the install directory is added to `plugins` in `~/.vibest/vibest.json`,
`cursor` appears in `vibest harness list`.

## H9. Antigravity (agy) is a plugin

With the shipped `harnesses/agy` folder of the install directory added to `plugins` in `~/.vibest/vibest.json`, `agy` appears
in `vibest harness list` and its models in `vibest models`, read from the agy CLI without a model turn, and
`vibest subscriptions` shows its usage windows (used percent, reset time) from `agy -p /usage`. vibest never reads agy's own
config or credential files and never signs in; a CLI that is not signed in is listed as unavailable with its own message.
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
