# Cursor reuses the logged-in `cursor-agent` via ACP

Cursor is a first-class harness. The Node adapter spawns `cursor-agent acp`
and reuses the subscription the user already created with `agent login`.

## Context

Cursor exposes three faces: the IDE agent, the `cursor-agent` CLI (ACP over
stdio, plus a one-shot `-p` mode), and `@cursor/sdk`. A `HarnessAgentRuntime`
has to prompt, interrupt, stream, and close without exiting.

`@cursor/sdk` looks like Claude's in-process SDK, but its stored login is
only a key minted by `Cursor.auth.login()` / `CURSOR_API_KEY`. It does not
read the desktop or CLI install. Headless `cursor-agent -p` exits after one
prompt and cannot host a runtime.

`cursor-agent acp` is the same door the user already authenticated. The
binary name must be `cursor-agent`, never `agent`: Grok's CLI ships an
`agent` that wins PATH resolution.

## Decision

- Wire id `cursor`.
- Spawn `cursor-agent acp`. Availability is a PATH lookup
  (`VIBEST_CURSOR_EXECUTABLE`, then `cursor-agent`, then `~/.local/bin` /
  `~/.cursor/bin`).
- Handshake: `initialize`, then `authenticate` with `methodId: "cursor_login"`
  when advertised.
- Probe models with `cursor/list_available_models`, never `session/new`.
- End a turn when `session/prompt` returns. Cursor ACP does not send a
  Grok-style `_x.ai` `turn_completed` notice.
- Map vibest `plan` / `ask` / `full` onto ACP session modes `plan` / `ask` /
  `agent`. Default is `full` (`agent`).

## Consequences

- Users who already ran `agent login` are available with no extra key.
- Interactive per-tool approval is `session/request_permission`, same as Grok.
- A relocated CLI needs `VIBEST_CURSOR_EXECUTABLE`.
