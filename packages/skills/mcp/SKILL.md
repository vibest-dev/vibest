---
name: mcp
description: Inspect and call MCP servers, tools, resources, and remote SEP-2640 skills via `vibest mcp`, run multi-tool JavaScript in the Psychoscript CodeMode sandbox (`vibest mcp exec`), handle truncated `ToolOutput` spills, and create or manage scheduled/event-driven automations (`vibest auto`). Use whenever working with MCP servers, CodeMode, remote MCP skills/events, or background automations.
---

# MCP, CodeMode & Automations

Use `vibest mcp` to discover and invoke MCP servers (configured in `mcp.json` / `.mcp.json` or added via `vibest mcp add`), `vibest mcp exec` to run sandboxed JavaScript across multiple tools in one call, and `vibest auto` to schedule recurring or event-driven automations.

## Inspect & Discover

- `vibest mcp add <name> -- npx -y @modelcontextprotocol/server-filesystem /dir` — add a local stdio MCP server (use `--` before command arguments like `-y`), or `vibest mcp add <name> --url <url>` for a remote HTTP MCP server.
- `vibest mcp list` — list configured MCP servers and their status.
- `vibest mcp list <server>` — list tools (with compact TypeScript input signatures), remote skills, and events on `<server>`.
- `vibest mcp list <server> <tool>` — full JSON Schema and details for a single tool.
- `vibest mcp list [server] --types` — emit TypeScript `declare const tools` declarations for CodeMode (`vibest mcp list vibest --types` shows built-in read-only `tools.vibest.*`).
- `vibest mcp list <server> --skills` — list SEP-2640 remote `skill://` documents advertised by `<server>`.
- `vibest mcp list <server> --events` — list SEP-3415 event types advertised by `<server>`.
- `vibest mcp search <query>` — search cached tool names and descriptions across servers.

## Read & Call

- `vibest mcp read <server> <uri>` — read an MCP resource or SEP-2640 `skill://` document (SHA-256 digest verified).
- `vibest mcp call <server> <tool> ['<json>']` (or `vibest mcp call <server>.<tool> ['<json>']`) — invoke a single MCP tool with a JSON object argument.

## CodeMode (`vibest mcp exec`)

Prefer `vibest mcp exec` over multiple sequential shell calls whenever chaining tools, calling tools in parallel, or filtering/aggregating large results before returning them to context.

```sh
vibest mcp exec [--server <s1> ...] [--input '<json>'] [--timeout <ms>] '<js code>'
vibest mcp exec [--server <s1> ...] [--input '<json>'] --file <path.js>
```

- Runs async ES2023 JavaScript in the Psychoscript sandbox (top-level `await` and `return` supported; no `fetch`, `fs`, `process`, or `eval`).
- Globals available inside the script:
  - `tools.<server_ident>.<tool_ident>(args)` — hyphenated server/tool names map to `snake_case` identifiers (check exact names with `vibest mcp list [server] --types`).
  - `tools.vibest.*` — built-in read-only Vibest queries such as `tools.vibest.session_list()`, `tools.vibest.project_info()`, `tools.vibest.mcp_list()`, `tools.vibest.automation_list()`.
  - `input` — parsed JSON value passed via `--input '<json>'`.
  - `load(key)` / `store(key, value)` — key-value scratch storage within execution.
- Use `Promise.all([...])` to batch parallel calls and filter/summarize data in JS before returning.

## Oversized Output Spills (`ToolOutput`)

Tool and CodeMode outputs exceeding **2,000 lines** or **50 KiB** are automatically truncated at UTF-8/grapheme boundaries and spilled in full to `<VIBEST_HOME>/tool-output/tool_*` (the exact file path is printed in the truncation notice). Search or slice that file with `rg`, `grep`, `sed`, or `head` instead of reading the entire file into context.

## Automations (`vibest auto`)

Create scheduled or event-driven background automations:

```sh
vibest auto create <name> \
  (--at '<time>' | --every '<dur>' | --cron '<expr>' | --event-server <s> --event <ev> [--event-args '<json>']) \
  (--prompt '<text>' | --code '<js>' | --code-file <file>) \
  [--args '<json>'] [--tz <iana>] [--expires '<time>'] [--session <id> | --agent <id>]
```

- `--every` accepts durations such as `"30 seconds"`, `"10 minutes"`, `"2 hours"`, or shorthand like `"30s"`, `"10m"`, `"2h"`.

- Running `vibest auto create` inside an agent session automatically binds your `VIBEST_SESSION_ID` as the default delivery target (override with `--session <id>` or `--agent <id>`).
- **0-token CodeMode gate (`--code` / `--code-file`)**:
  - Receives `input = { state, now, runs, args, event? }` (plus `tools.*`).
  - Return nothing / `null` (or `{ state }` without `send`) to stay silent and spend **0 LLM tokens**.
  - Return `{ state?, done?, send: { prompt, to? } }` to wake the target session with a message (set `done: true` to mark the automation finished).
- Manage automations:
  - `vibest auto list` — list automations and their status/run counts.
  - `vibest auto get <id>` — inspect full details, `runCount`, `state`, and schedule.
  - `vibest auto pause <id>` / `vibest auto resume <id>` — pause or resume an automation.
  - `vibest auto run-now <id>` — trigger an immediate run and return its result.
  - `vibest auto remove <id>` — delete an automation.
