# Automation

vibestd runs native event-driven automations (`at`, `every`, `cron`, and MCP `SEP-3415` push `event` triggers) backed by an OpenCode-aligned single operational SQLite `automation` table and 0-token Psychoscript CodeMode gates. Each capability below says what it is and when it counts as working.

## AUTO1. Scheduled triggers (`at`, `every`, `cron`) with event-driven timers

`vibest auto create` accepts one-shot `at` triggers (`"in 10 minutes"`, ISO instants with offsets, or zoned wall-clock times), periodic `every` durations (`"30 seconds"`, `"5 minutes"`, `"1 hour"`), and `cron` expressions parsed with IANA time zone support. `vibestd` runs zero background polling loops: it arms a single cancellable one-shot timer (`automation.next`) for `MIN(next_due_at)` and re-arms on `create`, `pause`, `resume`, `remove`, `tick`, and `runNow` (plus startup). Missed `every` intervals during downtime coalesce into a single run while preserving phase, and `cron` schedules skip repeated wall-clock instants during DST fallback so no slot fires twice.

## AUTO2. 0-Token CodeMode gate (`action.type === "code"`)

Code actions are syntax-checked at creation via `CodeMode.checkSyntax(code)` (`psychoscript` `parseProgram`) and execute
inside the confined `@vibest/codemode` `psychoscript/effect` bytecode VM (`30s` timeout, `20` max MCP tool calls, `32 KiB`
log cap) with bindings `{ input, state, now, runs, args, event? }` and lazy `Host.namespace` `@vibest/mcp` tool
dispatch. A runtime `allowTool` policy guard forbids `shell` and recursive `automation.*` / `*.automation_*` tools before
any invocation, immediately pausing the automation with `ToolDenied` if attempted. Return values are decoded strictly
(`null` or `{ state?, done?, send?: { prompt, to? } }`, rejecting excess properties). When `send` is omitted, zero LLM
tokens are spent and no session message or spawn occurs; when `send` is present, state and `done` commit only after
session delivery succeeds.

## AUTO3. Prompt delivery, target routing, and unread coalescing

`prompt` actions and CodeMode `send` handoffs deliver to an existing session (`{ sessionId }` via `Session.send`) or spawn a child agent session (`{ agent }` via `Session.spawn`), defaulting to the creating session when `to` is omitted. Every delivery carries a deterministic `aut:<id>:<run>` (or `aut:<id>:<run>:send` for code handoffs) request id persisted in `last_message_id`. When a scheduled timer `prompt` action targeting a specific session fires while its previous `last_message_id` is still `status = 'pending'` in `inbox`, `vibestd` coalesces the delivery by recording `lastOutcome: "skipped"` and advancing `next_due_at` without queuing a duplicate prompt.

## AUTO4. Operational single-table SQLite persistence and optimistic CAS `settle`

Automations live in a single operational SQLite table (`automation`, created by `20261125000000_automation`, separate from `PROJECTION_TABLES`), with zero `automation.*` rows in the append-only `event` ledger. `Bus.rebuild` and `equalToReplay` never drop or wipe `automation` rows. All SQL writes live exclusively in `packages/core/src/automation/sql.ts`. `remove` physically deletes the row, and run settlement uses optimistic CAS (`WHERE id = ? AND run_count = ? AND status = 'active' | status <> 'done'`) so concurrent `pause`, `remove`, or overlapping runs cannot clobber status or double-increment `run_count`.

## AUTO5. MCP SEP-3415 push event streams and `event_position` cursor durability

`event` automations subscribe to connected MCP servers advertising `delivery: ["push"]` via `events/stream`, managed in a `FiberMap<Automation.ID>`. `inputSchema` and `payloadSchema` are validated fail-closed, event payloads are capped at `16 KiB`, and cursors are capped at `4 KiB`. Stream resume progress is stored in a single `event_position` JSON column (`{ cursor?: string | null, id?: string }`): `{}` on create, `{ cursor: null }` immediately after stream open before the first heartbeat, updated in place on heartbeats and events with zero `event` ledger writes. Duplicate `eventId` deliveries matching `event_position.id` are skipped. If the server reports `truncated: true` or reconnects with a `null` cursor after opening, the automation pauses with an explicit diagnostic instead of silently dropping events. Untrusted event JSON injected into prompts is safely fenced and indented.

## AUTO6. Failure backoff and auto-pause protection

Transient failures in scheduled CodeMode runs back off by 1 minute and auto-pause after 3 consecutive failures (`MAX_CODE_FAILURES = 3`). Invalid code errors (parse errors, forbidden tools, invalid return shapes), failed delivery handoffs, and event-stream invalidations pause immediately with a bounded diagnostic in `lastOutput`.

## AUTO7. HttpApi surface, daemon capability, and `vibest auto` CLI

`vibestd` advertises `capabilities.automation: true` in `daemon.ping`, exposes the `server.automation` HttpApi group (`/api/automation`, `/api/automation/:id`, `/pause`, `/resume`, `/run-now`, `/tick`) documented in `packages/protocol/openapi.json`, and the CLI exposes `vibest auto create|list|ls|get|pause|resume|remove|rm|run-now`.
