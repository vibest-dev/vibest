# @vibest/claude: the vibest Claude Code plugin

One ordinary Claude Code plugin, one hooks module. Every call to vibest is an HTTP request from `$.http.fetch` to
vibestd's unix socket `<VIBEST_HOME>/vibest-http.sock`; the plugin runs no `vibest` process.

- `turn.complete` posts each main-loop turn end to `/hooks/claude/turn-end` with its `reason`, the answer and the
  current Claude session id. vibest maps the reason: `answer` is the result as it is; `aborted` is an interrupted
  (failed) result when the person pressed Esc, and nothing when `vibest interrupt` (or remove, archive) stopped the
  turn; `refusal` and `error` are failed results. A subagent's loop (`agentId` set) reports nothing. For the
  coordinator vibestd records only the conversation id.
- `prompt.submit` posts a worker's prompt with its `origin.kind` to `/hooks/claude/prompt`; vibest keeps only what
  the person submitted (`composer`, or `bridge` for Remote Control).
- `tool.call` posts each tool call, a subagent's included, to `/hooks/claude/guard` and returns `{ deny }` when vibest
  refuses it. It tries for 2 s, then again after 100, 300 and 900 ms; when nothing answers, the call is refused.
- The **coordinator inbox**: from `session.start`, a coordinator polls `/inbox/poll` every second. A batch comes as
  one short line (`<Type> Agent "<title>" completed (<id>) · +N more`) and its full text. The line is submitted with
  `$.prompt.submit` from the AbovePrompt `ui.render` hook, one batch per draw, and this module's own `prompt.submit`
  hook attaches the full text as context. An accepted submit is acked by row id (`/inbox/ack`) on the next tick; a
  `drop` puts the batch back at the front of the queue. The submit has to come from inside a hook's call stack: a
  submit from a clock callback would skip this module's own `prompt.submit` hook as re-entry. The module remembers the
  row ids it has taken, so a batch handed out again after its lease ran out or vibestd restarted is not shown twice:
  in a batch that mixes taken rows with new ones, the taken ones are acked and the new ones given back, so they come
  alone. Full texts wait for `prompt.submit` for at most the last 100 lines. A one-line notice is its own full text and
  is not attached again. Using the AbovePrompt render hook as a place to submit from is undocumented; E2E covers it.

Reports (turn end, prompt) retry in the background after 1, 2, 4, 8, 15 and 30 s while vibestd does not take them.
A failed report never blocks or continues a stopped turn. Five failed polls in a row put "vibestd unreachable" on the
status line. `Session.Ready` goes with Claude Code's own pid, read as the `$PPID` of a command the module runs, since
a restart signals that process. A failed hook is skipped unless its handler answers, so outside vibest every listener
answers with a pass. The tool arguments sent to the guard are the `tool.call` input without its reserved keys
(`tool`, `tool_use_id`, `consent`, `agentId`).

Every request carries the session headers from `@vibest/protocol` `sessionHeaders`: protocol, `VIBEST_SESSION_ID`,
`VIBEST_PROJECT_ID`, the current Claude session id, `VIBEST_AGENT`, `VIBEST_HARNESS`, the cwd, `VIBEST_RUNTIME` and the
plugin version. Paths carry no version; the only one is `PROTOCOL` in the `vibest-protocol` header. vibestd refuses a
request with an unknown session (404), a missing or wrong project id (403) or another protocol (409). A 409 body holds
vibestd's protocol and version, a message and the command to run (`action`); the plugin puts them on the status line
until a request goes through again, and the guard still refuses each tool call, giving them as the reason.

It ships inside `@vibest/cli` and is loaded only into the Claude sessions vibest starts (see Use).

## Build

This package is private: the plugin is published as part of `@vibest/cli`, whose build writes it to
`packages/cli/harnesses/claude` (`scripts/build-harnesses.ts`).

    bun scripts/build.ts <outdir>           # the complete plugin directory in <outdir>
    bun run build                           # the generated files in place, for the tests

The plugin directory holds exactly:

- `.claude-plugin/plugin.json`, generated: `src/manifest.json` with `version` set from this `package.json`.
- `hooks/hooks.json`: `"modules": ["./register.mjs"]` only. No command-hook map and no shell wrapper.
- `hooks/register.mjs`, generated: a single ES module with no imports. It bundles `src/plugin.ts` with the header
  helper it imports from `@vibest/protocol`; the build inlines the package version as `VIBEST_PLUGIN_VERSION`. Prebuilt JS is a delivery choice; Claude Code can also load TypeScript hooks modules.
- `README.md` and `LICENSE`.

`$.plugin` has no version, so the build inlines it. Bun writes each module's path relative to the working directory
into the bundle, so the build pins the working directory and the bytes do not vary.

The generated files are ignored by Git. `test/distribution.test.ts` packs this package and checks the extracted files.

## Use

Nothing to install. vibest starts each Claude session (and a Claude coordinator) with
`claude --plugin-dir <@vibest/cli>/harnesses/claude`, which loads the plugin for that session only. vibest writes
nothing into `~/.claude`. Plain `claude` sessions never load it, and in a Claude process without `VIBEST_AGENT` and
`VIBEST_SESSION_ID` every listener returns `next` and sends nothing.

**Mods are not sandboxed.** The module is code that Claude Code runs in its own process with your permissions. What it
does is narrow: POST to the fixed vibestd socket and submit the inbox line as a prompt. Its `tool.call` listener only
refuses; it registers no `tool.check` approval and changes no permission or policy setting. A module that does not
load guards nothing: with no `--settings`, the guard rules hold only while this module runs.

**`/clear`.** Claude Code 2.1.316 changes `$.session.id()` on `/clear`, fires `session.end` for the old id and no new
`session.start`; the poll timer keeps running. The plugin therefore has no `session.end` handler and sends the
current id on every request, and vibestd records the new id on the next request.

**Loading gate.** Claude Code statically analyzes a hooks module before loading it: `register` stays a top-level
`function` declaration and each hook passes `$` only to the top-level `nativeHost`. Hooks modules must be enabled for
non-builtin plugins (in 2.1.309 the rollout flag `tengu_plugin_hooks_modules` and accepted workspace trust); the plugin
does not read or change either. The AbovePrompt drain needs an interactive UI: under `claude -p` nothing is delivered.

## API source

`src/plugin.ts` imports types from `claude-code`. Those declarations are not in this repository. `bun scripts/prepare-claude-types.ts`,
which `pnpm run typecheck` runs before the plugin project (`tsconfig.plugin.json`), writes an ignored cache at
`packages/integration/claude/.cache/claude-code.d.ts`. A cold cache needs network access to GitHub.
It reuses that file only when its SHA-256 is `e51e637fbbebb2a6a49c4bdc3860a251c2ca2295884822dff0f4c3e3ec802163`, including a copy placed there by hand for offline use. Otherwise it fetches
`https://raw.githubusercontent.com/anthropics/claude-code/2eff7a8d21c80be48904f62ebdea36d945d7b504/mods/types/claude-code.d.ts` and keeps the result only when that checksum matches.
The pin is anthropics/claude-code `2eff7a8d21c80be48904f62ebdea36d945d7b504`, `mods/types/claude-code.d.ts`. The file's own
"Written by Claude Code 2.1.277" header is stale and does not date that pin. Upstream marks the file all rights reserved
under Anthropic's commercial terms. This repository does not assert permission to redistribute it, and a missing or
unverified cache fails typecheck instead of skipping the plugin project. The cache was not produced by running Claude or `/plugin-types`.

The listeners are `session.start`, `ui.render` (AbovePrompt), `turn.complete`, `prompt.submit` and `tool.call`. Native
calls stay in `register` or the top-level `nativeHost`: `$.http.fetch`, `$.session.cwd`, `$.session.id`, `$.env.get`,
`$.prompt.submit`, `$.clock.every`, `$.clock.after`, `$.ui.invalidate`, `$.ui.status`.

Hooks modules are early access and may change between releases. `claude plugin validate` and `claude plugin test` have
not been run on this revision. The E2E check I4 loads it with `--plugin-dir` into a real Claude: the guard refuses and the
turn end reports.
