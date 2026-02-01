---
status: done
priority: p2
issue_id: "009"
tags: [code-review, reliability, terminal]
dependencies: []
---

# Fire-and-Forget IPC Calls Lack Error Handling

## Problem Statement

Direct IPC calls for `terminal.write` and `terminal.resize` have no error handling. If the terminal is closed or IPC fails, these calls fail silently. User input may be lost.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx:81-88`

```typescript
const dataDisposable = terminal.onData((data) => {
  client.terminal.write({ terminalId, data });  // No .catch()
});

const resizeDisposable = terminal.onResize(({ cols, rows }) => {
  client.terminal.resize({ terminalId, cols, rows });  // No .catch()
});
```

## Proposed Solutions

### Option A: Add .catch() handlers (Recommended)

```typescript
client.terminal.write({ terminalId, data }).catch((err) => {
  console.error("Terminal write failed:", err);
  // Optionally show user notification
});
```

## Acceptance Criteria

- [ ] IPC errors are logged
- [ ] User notified of terminal disconnection
- [ ] No silent failures

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | Fire-and-forget still needs error handling |
| 2026-02-01 | Fixed: added .catch() handlers with [Terminal] prefix for write/resize | Also added comment explaining direct client vs TanStack Query pattern |
