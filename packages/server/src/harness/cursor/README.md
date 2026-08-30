# Cursor harness (`cursor-agent acp`)

Verified against `cursor-agent` 2026.08.25. The adapter speaks
[ACP](https://agentclientprotocol.com) over:

```
cursor-agent acp
```

That is the same logged-in CLI the user already ran `agent login` against.
Do not spawn `agent` — Grok's CLI also ships an `agent` binary, and it wins
PATH resolution. Do not use `@cursor/sdk`: its stored login is a separately
minted API key, not the desktop / CLI subscription.

Do not substitute `cursor-agent -p` (headless). That process exits when the
prompt ends and cannot host a `HarnessAgentRuntime`.

Handshake is `initialize` then `authenticate` with `methodId: "cursor_login"`
when that method is advertised. Models come from `cursor/list_available_models`.
A turn ends when `session/prompt` returns — Cursor ACP has no `_x.ai`
`turn_completed` notice.

Availability is a PATH lookup (`cursor-agent`, then `~/.local/bin` /
`~/.cursor/bin`), overridable with `VIBEST_CURSOR_EXECUTABLE`.

Tests speak a fake ACP child over stdio. There is no live-CLI smoke: a real
turn spends tokens and is not a regression gate.

Regenerate nothing — protocol types in `protocol.ts` are hand-written around
the ACP methods and Cursor extensions we consume. After bumping the CLI,
re-probe `initialize`, `authenticate`, `cursor/list_available_models`,
`session/new`, and `session/request_permission` before widening the types.
