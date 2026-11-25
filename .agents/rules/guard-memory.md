# Guard and Memory

1. Every new path that opens a terminal passes the session key, so `VIBEST_PROJECT_DIR` is set. Its subfolders are fixed: `docs/`, `memories/`, `artifacts/`. A `general` session gets the folder without permission prompts (Claude: `permissions.additionalDirectories` in an inline `--settings` and `Read`/`Edit` allow rules limited to it; not `--add-dir`, which also loads the folder's skills, commands and agents and asks before it does).
2. Pre-tool guard checks run through `@vibest/plugin` hooks (`ctx.session.hook("tool.execute.before", ...)`). `AgentDefinition` carries no per-agent `guard` callback.
3. Core (`packages/core/src/guard.ts`) decodes harness `PreToolUse` JSON, resolves `cwd` (`input.cwd` or the single `workspace_roots[0]`, plus `tool_input.cwd` when present, handling `file://` and `~`), and calls `Plugins.Service.guard` with `{ session: { id, agent, project, projectDir }, tool, input, cwd }`. Malformed hook input still fails and refuses the call.
4. The builtin plugin `vibest.guard` (`packages/builtins/src/guard.ts`) uses only `@vibest/plugin/effect` and enforces two minimal protocol self-protection invariants on shell tools (`bash`, `powershell`, `shell`):
   - Running `vibest` with `VIBEST_SESSION_ID` assigned, exported, unset, or cleared anywhere in the command (since caller identity comes from `VIBEST_SESSION_ID`).
   - Invoking socket/HTTP tools (`curl`, `nc`, `ncat`, `socat`, `wget`) targeting `vibest-http.sock` (the harness's hook socket).
5. Everything else (`hc`, `rex`, `herdr`, `~/.vibest`, `gh`, file edits) is allowed by default unless a user plugin refuses it with `ToolRefused({ reason })`. Which `vibest` commands an agent may run is enforced directly where they run (`caller.ts` `userOnly`, `server.ts` `ACCESS`), not in the guard.
6. The guard checks what a tool call says; it is not a sandbox. A call is allowed unless a `tool.execute.before` plugin refuses it, and a `tool.execute.before` hook that crashes or times out is logged and skipped so a broken user plugin does not brick all tool calls.

Status: in force (`packages/core/src/guard.ts`, `packages/builtins/src/guard.ts`).
