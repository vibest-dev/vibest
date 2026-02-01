---
status: done
priority: p2
issue_id: "011"
tags: [code-review, architecture, react]
dependencies: []
---

# Duplicate Query in TerminalContainer and TerminalTabs

## Problem Statement

Both `TerminalContainer` and `TerminalTabs` independently query the same terminal list. While TanStack Query deduplicates requests, this creates code duplication and makes data flow harder to trace.

## Findings

**Location 1:** `apps/desktop/src/renderer/src/components/terminal/terminal-container.tsx:26-28`
```typescript
const { data: terminals = [] } = useQuery(
  orpc.terminal.list.queryOptions({ input: { worktreeId } }),
);
```

**Location 2:** `apps/desktop/src/renderer/src/components/terminal/terminal-tabs.tsx:31-33`
```typescript
const { data: terminals = [], isSuccess } = useQuery(
  orpc.terminal.list.queryOptions({ input: { worktreeId } }),
);
```

## Proposed Solutions

### Option A: Merge TerminalContainer into TerminalTabs (Recommended)

Rename `TerminalTabs` to `TerminalPanel`, include view rendering, eliminate `TerminalContainer`.

- **Effort:** Medium
- **Impact:** -54 lines, clearer data flow

### Option B: Lift query to parent and pass as props

- **Effort:** Small
- **Impact:** Keeps component separation

## Acceptance Criteria

- [ ] Single query for terminal list per worktree
- [ ] Clear data flow from parent to children
- [ ] No unnecessary re-renders

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | Lift queries to avoid duplication |
| 2026-02-01 | Fixed: merged TerminalContainer + TerminalTabs into TerminalPanel | Single query, simpler component hierarchy |
