---
status: done
priority: p2
issue_id: "012"
tags: [code-review, react, bug]
dependencies: []
---

# autoCreateInitiated Ref Not Reset on worktreeId Change

## Problem Statement

The `autoCreateInitiated` ref prevents double-creation in React Strict Mode, but it never resets. If `worktreeId` changes, the ref remains `true` from the previous worktree, preventing auto-creation for the new worktree.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx:28, 51-63`

```typescript
const autoCreateInitiated = useRef(false);  // Never reset

useEffect(() => {
  if (... && !autoCreateInitiated.current) {
    autoCreateInitiated.current = true;  // Set but never cleared
    createTerminal.mutate({ worktreeId, cwd: worktreePath });
  }
}, [worktreeExists, isSuccess, terminals.length, worktreeId, worktreePath, createTerminal]);
```

## Proposed Solutions

### Option A: Key component by worktreeId (Recommended)

In `App.tsx`, add key to force remount:
```tsx
<TerminalTabs key={worktreeId} worktreeId={worktreeId} ... />
```

### Option B: Reset ref when worktreeId changes

```typescript
const prevWorktreeId = useRef(worktreeId);
useEffect(() => {
  if (prevWorktreeId.current !== worktreeId) {
    autoCreateInitiated.current = false;
    prevWorktreeId.current = worktreeId;
  }
}, [worktreeId]);
```

## Acceptance Criteria

- [ ] Switching worktrees triggers auto-creation if needed
- [ ] React Strict Mode double-creation still prevented
- [ ] No stale state from previous worktree

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | Refs need lifecycle management |
| 2026-02-01 | Verified fixed: key={worktree.id} already ensures each worktree has separate component instance | React key prop handles instance isolation |
