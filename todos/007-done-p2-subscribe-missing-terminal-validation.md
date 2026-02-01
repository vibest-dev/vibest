---
status: done
priority: p2
issue_id: "007"
tags: [code-review, reliability, terminal]
dependencies: []
---

# Missing Terminal Existence Validation Before Subscribe

## Problem Statement

The `subscribe` handler does not verify that the terminal exists before subscribing. This could lead to subscribing to non-existent terminals or race conditions.

## Findings

**Location:** `apps/desktop/src/main/ipc/router/terminal.ts:43-55`

```typescript
export const subscribe = os.subscribe.handler(async function* ({ input, signal, context: { app } }) {
  const { terminalId } = input;
  const iterator = app.terminal.subscribe(terminalId, { ... });
  // No check if terminal exists
```

## Proposed Solutions

### Option A: Validate terminal exists (Recommended)

```typescript
export const subscribe = os.subscribe.handler(async function* ({ input, signal, context: { app } }) {
  const { terminalId } = input;
  const terminal = app.terminal.get(terminalId);
  if (!terminal) {
    throw new Error("Terminal not found");
  }
  // ...
});
```

## Acceptance Criteria

- [ ] Subscribe validates terminal exists
- [ ] Clear error when subscribing to non-existent terminal
- [ ] Race condition documented or handled

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | Validate resources before operations |
| 2026-02-01 | Fixed: check terminal.get() before subscribing | Throw error if terminal not found |
