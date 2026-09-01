# Grok talks ACP stdio, one child per session

Grok (`grok` CLI) is a first-class harness. The Node adapter speaks the Agent Client Protocol over `grok agent --no-leader stdio`, with one child process per vibest session.

## Context

Grok exposes three faces: the interactive TUI, one-shot headless (`grok -p`), and ACP (`grok agent stdio`). A `HarnessAgentRuntime` has to prompt, interrupt, round-trip permissions, and close without exiting. Headless exits when the prompt ends. ACP is the long-lived JSON-RPC door.

ACP can host many sessions in one process (`session/new` / `session/load`). Codex already shares one app-server for that reason. Pi does not: its RPC mode hosts a single session, so crash isolation is free.

`--leader` (and `[cli] use_leader`) attaches a new ACP client to the user's TUI leader. A vibest session that did that would mix into the interactive dashboard.

## Decision

- Wire id `grok` (CLI name, matching `codex` / `pi`).
- Spawn `grok agent --no-leader stdio` with `GROK_DISABLE_AUTOUPDATER=1`.
- One child per session. A shared agent is a later deepening.
- Probe models with `_x.ai/models/list` after `initialize`, never `session/new` (that runs SessionStart hooks and writes a session).

## Consequences

- A crashed Grok child takes only its own session.
- Availability is a PATH lookup plus the installer dirs `~/.grok/bin` and `~/.local/bin`; spawn uses the resolved absolute path so the two cannot drift.
- Protocol types are hand-written in `packages/server/src/harness/grok/protocol.ts`. Bumping `grok` means re-probing the methods listed in that directory's README, not regenerating a schema.
