# Grok harness (ACP stdio)

Verified against `grok` 1.0.5. The adapter speaks [ACP](https://agentclientprotocol.com) over:

```
grok agent --no-leader stdio
```

`--no-leader` is load-bearing: without it the child may attach to the user's TUI leader. `GROK_DISABLE_AUTOUPDATER=1` is injected for the same reason Grok's own SDKs do.

Do not substitute `grok -p` (headless). That process exits when the prompt ends and cannot host a `HarnessAgentRuntime`.

Regenerate nothing — protocol types in `protocol.ts` are hand-written around the ACP methods and `_x.ai/*` extensions we consume. After bumping the CLI, re-probe `initialize`, `session/new`, `_x.ai/models/list`, `session/set_model`, and `session/request_permission` before widening the types.
