---
status: done
priority: p3
issue_id: "017"
tags: [code-review, observability, quality]
dependencies: []
---

# Inconsistent Error Logging Format

## Problem Statement

Error logging uses raw `console.error` with inconsistent formats across files.

## Findings

**Locations:**

- `terminal-manager.ts:153`: `console.error("Resize error:", err);`
- `terminal-manager.ts:165`: `console.error("Kill error:", err);`
- `terminal-view.tsx:126`: `console.error("Terminal subscription error:", error);`

## Proposed Solutions

### Option A: Create logging utility

```typescript
// lib/logger.ts
export const logger = {
  error: (context: string, error: unknown) => {
    console.error(`[${context}]`, error);
  },
};
```

### Option B: Use structured logging library

Consider pino or similar for production observability.

## Acceptance Criteria

- [ ] Consistent error format
- [ ] Context included in all errors
- [ ] Consider structured logging

## Work Log

| Date       | Action                                                            | Learnings                                       |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| 2026-02-01 | Identified via code review                                        | Consistent logging aids debugging               |
| 2026-02-01 | Fixed: standardized all error logs to use [Context] prefix format | [TerminalManager] and [Terminal] prefixes added |
