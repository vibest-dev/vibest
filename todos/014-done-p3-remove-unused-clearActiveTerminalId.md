---
status: done
priority: p3
issue_id: "014"
tags: [code-review, cleanup, yagni]
dependencies: []
---

# Remove Unused clearActiveTerminalId

## Problem Statement

The `clearActiveTerminalId` function is defined but never called anywhere in the codebase.

## Findings

**Location:** `apps/desktop/src/renderer/src/stores/slices/terminal-slice.ts:23-27`

```typescript
clearActiveTerminalId: (worktreeId) =>
  set((state) => {
    const { [worktreeId]: _, ...rest } = state.activeTerminalId;
    return { activeTerminalId: rest };
  }),
```

Grep shows only the definition, no usages.

## Proposed Solutions

Remove the dead code.

## Acceptance Criteria

- [ ] `clearActiveTerminalId` removed from interface and implementation
- [ ] No compile errors

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | YAGNI - remove unused code |
| 2026-02-01 | Fixed: removed clearActiveTerminalId from interface and implementation | Dead code removed |
