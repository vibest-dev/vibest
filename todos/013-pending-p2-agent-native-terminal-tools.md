---
status: pending
priority: p2
issue_id: "013"
tags: [code-review, agent-native, architecture]
dependencies: []
---

# No Agent-Native Terminal Tools

## Problem Statement

The terminal integration is UI-first. While oRPC APIs exist, AI agents cannot:

1. Execute commands and get output (fire-and-forget only)
2. Retrieve terminal history
3. Know which terminals exist
4. See output that was already displayed

The Claude Code agent has a separate `Bash` tool that operates invisibly, disconnected from the visible terminals.

## Findings

**Current capabilities:**

- `terminal.create` - exists but not exposed to agent
- `terminal.write` - fire-and-forget, no output capture
- `terminal.subscribe` - streaming only, no history

**Missing capabilities:**

- `terminal.execute({ command, timeout })` - run command, return output
- `terminal.getHistory({ terminalId, lines })` - get recent output
- System prompt injection of available terminals

## Proposed Solutions

### Option A: Add execute-with-output API (Recommended)

```typescript
// In terminal contract
execute: oc.input(z.object({
  terminalId: z.string(),
  command: z.string(),
  timeout: z.number().optional(),
})).output(z.object({
  output: z.string(),
  exitCode: z.number().optional(),
})),
```

### Option B: Add history retrieval API

```typescript
getHistory: oc.input(z.object({
  terminalId: z.string(),
  lines: z.number().default(100),
})).output(z.object({
  history: z.string(),
})),
```

### Option C: Create agent terminal tools in ai-sdk-agents

Add `TerminalExecute`, `TerminalGetHistory`, `TerminalList` tools.

## Acceptance Criteria

- [ ] Agent can execute command and receive output
- [ ] Agent can query terminal history
- [ ] Agent system prompt includes terminal context
- [ ] Parity between what user and agent can do

## Work Log

| Date       | Action                     | Learnings                                        |
| ---------- | -------------------------- | ------------------------------------------------ |
| 2026-02-01 | Identified via code review | Agent-native = agent has same capabilities as UI |
