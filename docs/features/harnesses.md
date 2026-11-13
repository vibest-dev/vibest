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
the shipped `harnesses/cursor/plugin.js` of the install directory is added to `plugins` in `~/.vibest/vibest.json`,
`cursor` appears in `vibest harness list`.

## H9. Antigravity (agy) is a plugin

With the shipped `harnesses/agy/plugin.js` of the install directory added to `plugins` in `~/.vibest/vibest.json`, `agy` appears
in `vibest harness list` and its models in `vibest models`, read from the agy CLI without a model turn, and
`vibest subscriptions` shows its usage windows (used percent, reset time) from `agy -p /usage`. vibest never reads agy's own
config or credential files and never signs in; a CLI that is not signed in is listed as unavailable with its own message.
The definition's `binary` can be pointed at a wrapper such as `agyx` by a plugin of the user's own; nothing assumes it is
named `agy`.

## H10. An agy session runs on the runtime's state

`vibest run agy -- <task>` starts agy with the task after the system prompt; the execution completes when agy goes idle (no reply
text: `vibest peek` shows the answer), and the session records agy's conversation id. A `vibest send` while it is idle is the
next execution. When its pane closes, the next send resumes the same conversation with `agy --conversation`. agy asks its
own permissions: a tool confirmation shows the session blocked and keeps its execution open.

## H11. agy's state reaches herdr-core

In a terminal on herdr-core, an agy session started by vibest shows working while it works, blocked while a tool confirmation
or its sign-in shows, and idle after it, as its session-only status line reports them. Nothing is installed in agy and agy's
settings are not changed.
