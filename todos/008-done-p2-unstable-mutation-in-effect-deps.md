---
status: done
priority: p2
issue_id: "008"
tags: [code-review, react, quality]
dependencies: []
---

# Effect Dependency Array Includes Unstable Mutation Object

## Problem Statement

The `createTerminal` mutation object from `useMutation` is included in the useEffect dependency array. Mutation objects are not stable references - they change on every render.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx:63`

```typescript
}, [worktreeExists, isSuccess, terminals.length, worktreeId, worktreePath, createTerminal]);
//                                                                         ^^^^^^^^^^^^^^
```

The `autoCreateInitiated` ref protects against double-creation, but this is still incorrect and could mask issues.

## Proposed Solutions

### Option A: Remove from dependency array (Recommended)

```typescript
// Add exhaustive-deps disable for this specific case
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [worktreeExists, isSuccess, terminals.length, worktreeId, worktreePath]);
```

### Option B: Use mutation.mutate in a stable callback

```typescript
const handleCreateTerminal = useCallback(() => {
  createTerminal.mutate({ worktreeId, cwd: worktreePath });
}, [worktreeId, worktreePath]);
```

## Acceptance Criteria

- [ ] Effect dependency array is correct
- [ ] No unnecessary effect re-runs
- [ ] ESLint rule handled appropriately

## Work Log

| Date       | Action                                                              | Learnings                            |
| ---------- | ------------------------------------------------------------------- | ------------------------------------ |
| 2026-02-01 | Identified via code review                                          | useMutation returns unstable objects |
| 2026-02-01 | Fixed: removed createTerminal from deps with eslint-disable comment | Mutation refs are not stable         |
