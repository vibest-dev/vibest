# @vibest/claude: the vibest Claude Code plugin

One ordinary Claude Code plugin with two parts:

- **Native classic listeners** for every VIBEST session, workers and the coordinator: `classic.Stop` and
  `classic.StopFailure` report the turn end (a worker's result, or the coordinator's Claude session) by running
  `vibest integration stop --harness claude`. A worker's turn stopped with Esc fires neither, and one that ends on an error
  may fire no StopFailure: `turn.complete` (reason `aborted` or `error`, main loop, not already reported by Stop or
  StopFailure since `turn.start`) reports it the same way as `TurnComplete`, which vibest delivers as a failed result. `classic.PreToolUse` runs `vibest integration guard --harness claude`. These are native event names, not
  command-hook registrations.
- **The inbox module**, for a Claude **coordinator** only: it delivers VIBEST inbox claims into the coordinator as prompts,
  through the native hooks API.

It ships inside `@vibest/cli` and is loaded only into the Claude sessions vibest starts (see Use).

## Build

This package is private: the plugin is published as part of `@vibest/cli`, whose build writes it to
`apps/vibest-herdr/harnesses/claude` (`scripts/build-harnesses.ts`).

    bun scripts/build.ts <outdir>           # the complete plugin directory in <outdir>
    bun run build                           # the generated files in place, for the tests

The plugin directory holds exactly:

- `.claude-plugin/plugin.json`, generated: `src/manifest.json` with `version` set from this `package.json`.
- `hooks/hooks.json`: `"modules": ["./register.mjs"]` only. No command-hook map and no shell wrapper.
- `hooks/register.mjs`, generated: a single ES module with no imports. It bundles `src/plugin.ts` together with the
  client (`src/inbox-client.ts`) and the adapters (`src/inbox-adapter.ts`) it uses. The native `classic.*` listeners are
  in that module. Prebuilt JS is a delivery choice; Claude Code can also load TypeScript hooks modules.
- `README.md` and `LICENSE`.

The generated files are ignored by Git. `test/distribution.test.ts` packs this package and checks the extracted files.

## Use

Nothing to install. vibest starts each Claude session (and a Claude coordinator) with
`claude --plugin-dir <@vibest/cli>/harnesses/claude`, which loads the plugin for that session only, beside the plugins
the user installed. vibest writes nothing into `~/.claude`. Plain `claude` sessions never load it.

**The `vibest` it calls is the one on PATH.** The module calls the bare `vibest`: `vibest inbox …` for the inbox, and
`vibest integration stop --harness claude` / `vibest integration guard --harness claude` for the native listeners. There
is no shell and no `VIBEST_COMMAND` override.

**Mods are not sandboxed.** The inbox module is a mod, code that Claude Code runs in its own process with your permissions.
Its own `$.fs` and `$.process` calls do not go through Claude's tool permission rules or `PreToolUse` hooks, and a
process it starts runs outside the Bash sandbox. What it intends to do is narrow: run the fixed bare argv `vibest inbox attach|pull|ack|release …`,
`vibest integration stop --harness claude` and `vibest integration guard --harness claude`, read the claim file `vibest inbox pull` names, and submit that text
as a prompt. The
module registers no `tool.call` interception, no `tool.check` approval, and changes no permission or policy setting.
`classic.PreToolUse` is a native listener in this module. It is not the settings.json command hook.

**Where it acts.** The plugin loads only into the Claude sessions vibest starts. The native listeners are always registered there.
`classic.PreToolUse` calls vibest only when `VIBEST_AGENT` is set; `classic.Stop` and `classic.StopFailure` call vibest only
when `VIBEST_AGENT` and `VIBEST_SESSION_ID` are both set. Elsewhere they return `next` and do not call vibest. The inbox
module acts only in a process whose environment marks it as an VIBEST coordinator. That environment is what `vibest`
sets up:

- `VIBEST_AGENT=coordinator` and `VIBEST_SESSION_ID`;
- `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`;
- the reported Claude session that the daemon fences on.

The module always registers `session.start`, `session.end`, `command.run`, and the three `classic.*` listeners. In any other
process (a worker, or a plain `claude`) they activate no receiver: the module registers no `/vibest-reattach` command,
starts no timer and never calls `vibest inbox`. Setting the VIBEST
variables by hand is not a substitute, because it does not create the coordinator's daemon-side identity.

**Loading gate.** Claude Code statically analyzes a hooks module before loading it. Claude Code 2.1.316 loaded this
revision in `claude -p` (E2E I4): `classic.PreToolUse` refused a herdr call and `classic.Stop` wrote the result. The inbox
module has not been exercised in a live coordinator.

- `register` stays a top-level `function` declaration. Each hook passes `$` only to the top-level `nativeHost`.
- The distribution test checks that `register` is declared and exported, that `hooks.json` has no command hooks, that no
  shell wrapper is shipped, and that the official-type source still bundles to import-free JS.

## Prerequisites (not checked, not forced)

- **Hooks modules enabled.** Claude Code must load hooks modules for non-builtin plugins. In 2.1.309 that depends on the
  rollout flag `tengu_plugin_hooks_modules` and on accepted workspace trust (interactive sessions). The plugin does not
  read or change either, and does not fake readiness when they are off. A module that does not load cannot receive
  messages. A bridge attachment made earlier can still leave paste delivery suppressed, because VIBEST keeps the bridge
  marker across receiver loss and restarts; disabling the plugin, or a module that fails to load, does not restore
  paste delivery automatically.
- **`vibest` on PATH with the `inbox` command.** Calls are the bare argv `vibest inbox attach|pull|ack|release …`, run
  through `$.process.run` with the host's PATH and environment, with no shell. An `vibest` without `inbox` makes attach fail
  with an exit code, and the status line says so.
- **This Claude session reported to VIBEST.** VIBEST learns the coordinator's Claude session from the `Stop` /
  `StopFailure` hook when a turn ends; there is no SessionStart report. Until then attach answers `not-reported`, and
  the module keeps polling with ordinary attach (see Behavior). Before the first turn ends nothing is delivered.

## Behavior

**At startup** (the first `session.start`):

- Registers `/vibest-reattach` as `immediate`, so it also runs mid-turn, and one poll every 2 s.
- Polls never overlap, and each `vibest` call has a 15 s timeout.
- The first poll runs `vibest inbox attach <session id>`, without replace.
- If attach answers `not-reported` (exit 0, that error alone, no generation), nothing was attached: the status line says
  it is waiting, and the next poll runs the same ordinary attach again. It never adds `--replace`.
- Any other refusal stops polling, and the status line says what to do:
  - `stale-receiver`: another receiver is attached;
  - a nonzero exit: `vibest` failed or has no `inbox` command;
  - no reply, or a reply that cannot be read or contradicts itself.
- Once attached, the existing bridge marker suppresses Herdr paste delivery; the Claude adapter's `inbox` is `bridge`, so without one rows are pasted.

**Each poll:**

- Reads `$.session.id()` and pulls a claim.
- Reads the claim body with `$.fs.read`, never from stdout, and submits it with `$.prompt.submit`.
- Then settles the claim:

  | Submit result                | Settlement                                                                 |
  | ---------------------------- | -------------------------------------------------------------------------- |
  | Accepted or queued           | `ack`. This means delivery was accepted, not that an VIBEST task finished. |
  | Definite `drop`              | `release --retry`                                                          |
  | Ambiguous (the submit threw) | `release`                                                                  |

- A lost settlement retries the same settlement and never submits again.

**When the session ends** (`session.end`: `/clear`, resume, exit):

- Polling stops, and the status line asks for `/vibest-reattach`.
- The end is permanent for this receiver. Ordinary polling never undoes it. A session id read that was in flight when the
  session ended is discarded. Only a confirmed `/vibest-reattach` starts delivery again.
- Callbacks still in flight from the ended session cannot settle, and cannot submit anything new.

**`/vibest-reattach`:**

- Runs `vibest inbox attach <current session id> --replace`. One reattach runs at a time. A `not-reported` answer here is
  a refusal like any other: the inbox is unchanged.
- **A generation is confirmed:** it is used only if no `session.end` happened while the command waited. Polling then
  continues under it, even if a step of the old generation is still waiting.
- **Old callbacks:** they cannot settle, pull or submit under the new generation. But a prompt the old generation had
  already handed to `$.prompt.submit` may still land once.
- **Refusal printed by the server:** the inbox is unchanged.
- **No usable answer** (timeout, nonzero exit, unparsable output): the replace may have committed and retired this
  receiver. It is reported as unknown and never replayed automatically. Run `/vibest-reattach` again.

**Not done:** a shared store, takeover after a reload, detach, leases, or recovery after a pane move. A reloaded module
is a new receiver: it gets `stale-receiver` until `/vibest-reattach`.

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

The listeners are `classic.Stop`, `classic.StopFailure`, `turn.start`, `turn.complete`, `classic.PreToolUse`,
`session.start`, `session.end` and `command.run`. Native calls stay in `register` or the top-level `nativeHost`: `$.process.run`, `$.session.cwd`,
`$.session.id`, `$.env.get`, `$.fs.read`, `$.prompt.submit`, `$.command.register`, `$.clock.every`, `$.ui.status`.

Hooks modules are early access and may change between releases. `claude plugin validate` and `claude plugin test` have
not been run on this revision. The E2E check I4 loads it with `--plugin-dir` into a real Claude: the guard refuses and the
turn end reports.
