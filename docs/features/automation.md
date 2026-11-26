# Automation

vibestd runs native event-driven automations (`at`, `every`, `cron`, `webhook`, and MCP `SEP-3415` push `event` triggers) backed by the event-sourced ledger and 0-token Psychoscript CodeMode gates. Each capability below says what it is and when it counts as working.

## AUTO1. Scheduled triggers (`at`, `every`, `cron`) with event-driven timers

`vibest auto create` accepts one-shot `at` triggers (`"in 10 minutes"`, ISO instants with offsets, or zoned wall-clock times), periodic `every` durations (`"30 seconds"`, `"5 minutes"`, `"1 hour"`), and `cron` expressions parsed with IANA time zone support. `vibestd` runs zero background polling loops: it arms a single cancellable one-shot timer for `MIN(next_due_at)` and re-arms on `automation.*` bus commits. Missed `every` intervals during downtime coalesce into a single run while preserving phase, and `cron` schedules skip repeated wall-clock instants during DST fallback so no slot fires twice.

## AUTO2. 0-Token CodeMode gate (`action.type === "code"`)

Code actions are syntax-checked at creation via `CodeMode.checkSyntax(code)` (`psychoscript` `parseProgram`) and execute
inside the confined `@vibest/codemode` `psychoscript/effect` bytecode VM (`30s` timeout, `20` max MCP tool calls, `32 KiB`
log cap) with bindings `{ input, state, now, runs, args, event?, webhook? }` and lazy `Host.namespace` `@vibest/mcp` tool
dispatch. A runtime `allowTool` policy guard forbids `shell` and recursive `automation.*` / `*.automation_*` tools before
any invocation, immediately pausing the automation with `ToolDenied` if attempted. Return values are decoded strictly
(`null` or `{ state?, done?, send?: { prompt, to? } }`, rejecting excess properties). When `send` is omitted, zero LLM
tokens are spent and no session message or spawn occurs; when `send` is present, state and `done` commit only after
session delivery succeeds.

## AUTO3. Prompt delivery and target routing

`prompt` actions and CodeMode `send` handoffs deliver to an existing session (`{ sessionId }` via `Session.send`) or spawn a child agent session (`{ agent }` via `Session.spawn`), defaulting to the creating session when `to` is omitted. Every delivery carries a deterministic `aut:<id>:<run>` request id.

## AUTO4. Authenticated webhooks with idempotency deduplication

`webhook` automations are invoked via `POST /api/automation/:id/webhook`. When configured with a secret or `secretHash`, requests are authenticated via timing-safe HMAC-SHA256 (`x-vibest-signature-256: sha256=<hex>`) or `Authorization: Bearer <secret>` (returning HTTP 401 otherwise). Duplicate deliveries carrying a previously processed `x-idempotency-key` return `{ accepted: true, deduplicated: true }` without re-executing the action.

## AUTO5. MCP SEP-3415 push event streams and cursor durability

`event` automations subscribe to connected MCP servers advertising `delivery: ["push"]` via `events/stream`, managed in a `FiberMap<Automation.ID>`. `inputSchema` and `payloadSchema` are validated fail-closed, event payloads are capped at `16 KiB`, and cursors are capped at `4 KiB`. Latest cursors are durably persisted via `automation.cursor.saved`. If the server reports `truncated: true` or drops the cursor to `null` on reconnect when a prior cursor existed, the automation pauses with an explicit diagnostic instead of silently dropping events. Untrusted event JSON injected into prompts is safely fenced and indented.

## AUTO6. Event-sourced ledger durability and projection replay

All automation mutations emit durable events (`automation.created`, `automation.paused`, `automation.resumed`, `automation.removed`, `automation.triggered`, `automation.cursor.saved`) in `bus.transaction`, projected by `packages/core/src/automation/projector.ts` into the `automation` and `automation_dedup` tables. Full ledger replay produces byte-for-byte identical projection tables.

## AUTO7. Failure backoff and auto-pause protection

Transient failures in scheduled CodeMode runs back off by 1 minute and auto-pause after 3 consecutive failures (`MAX_CODE_FAILURES = 3`). Invalid code errors (parse errors, forbidden tools, invalid return shapes), failed delivery handoffs, and event-stream invalidations pause immediately with a bounded diagnostic in `lastOutput`.

## AUTO8. HttpApi surface, daemon capability, and `vibest auto` CLI

`vibestd` advertises `capabilities.automation: true` in `daemon.ping`, exposes the `server.automation` HttpApi group (`/api/automation`, `/api/automation/:id`, `/pause`, `/resume`, `/run-now`, `/webhook`, `/tick`) documented in `packages/protocol/openapi.json`, and the CLI exposes `vibest auto create|list|ls|get|pause|resume|remove|rm|run-now`.
