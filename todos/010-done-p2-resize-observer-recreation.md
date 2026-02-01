---
status: done
priority: p2
issue_id: "010"
tags: [code-review, performance, react]
dependencies: []
---

# ResizeObserver Recreated on Visibility Change

## Problem Statement

The ResizeObserver effect depends on `isVisible`. Every visibility toggle creates a new ResizeObserver and disconnects the old one, causing unnecessary object creation and GC pressure.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx:156-189`

```typescript
useEffect(() => {
  // ... ResizeObserver setup
}, [isVisible]); // <-- dependency causes recreation
```

## Proposed Solutions

### Option A: Remove isVisible dependency, check inside callback (Recommended)

```typescript
useEffect(() => {
  const resizeObserver = new ResizeObserver((entries) => {
    if (!isVisibleRef.current || !fitAddonRef.current) return;
    // ... rest of logic
  });
  // ... setup
  return () => resizeObserver.disconnect();
}, []); // Empty deps - create once
```

Use `isVisibleRef` (already exists on line 21-22) instead of `isVisible` prop.

## Acceptance Criteria

- [ ] ResizeObserver created once on mount
- [ ] Visibility check uses ref for current value
- [ ] No recreation on tab switch

## Work Log

| Date       | Action                                                                       | Learnings                                    |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| 2026-02-01 | Identified via code review                                                   | Avoid deps that cause frequent effect reruns |
| 2026-02-01 | Fixed: removed isVisible from deps, use isVisibleRef.current inside callback | ResizeObserver created once on mount         |
