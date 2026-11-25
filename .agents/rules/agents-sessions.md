# Agents and Sessions

1. **Unified session model (PR #645)**: core has no `coordinator`, `main`, or `entry_session_id` special-casing. Every session—whether opened directly by the user (`vibest`) or started by another session (`vibest run`)—uses the same lifecycle, execution recording, and delivery primitives. How an agent coordinates or delegates lives solely in its `AgentDefinition` prompt (`packages/builtins/src/agent.ts`).
2. **Notice discipline**: a notice reaches a parent or user session only when it has something to act on (exited, failed to start, ended with error, permission wait, undeliverable message), because each notice costs an execution.
3. **Session titles**: every spawned session carries a title (`vibest run --title`): 3 to 6 words, verb first, first letter capitalised, any language, describing what is done rather than how.
4. **Short IDs and `--machine`**: human and prompt surfaces display 8-char short session IDs and accept `--machine <name>` for remote sessions; JSON outputs always include the full canonical UUID alongside `machine`.

Status: in force on `main`.
