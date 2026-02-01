---
status: done
priority: p3
issue_id: "016"
tags: [code-review, configuration, terminal]
dependencies: []
---

# Hardcoded Terminal Theme

## Problem Statement

Terminal theme colors are hardcoded inline rather than being configurable or referencing a shared theme system.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-view.tsx:36-58`

```typescript
theme: {
  background: "#0a0a0a",
  foreground: "#fafafa",
  cursor: "#fafafa",
  // ... all hardcoded
}
```

## Proposed Solutions

### Option A: Extract to constants file

```typescript
// lib/terminal-theme.ts
export const TERMINAL_THEME = { ... };
```

### Option B: Integrate with app theme system

Make terminal colors derive from Tailwind/CSS variables.

## Acceptance Criteria

- [ ] Theme extracted from component
- [ ] Theme configurable (future)

## Work Log

| Date       | Action                                                            | Learnings                     |
| ---------- | ----------------------------------------------------------------- | ----------------------------- |
| 2026-02-01 | Identified via code review                                        | Extract magic values          |
| 2026-02-01 | Fixed: created lib/terminal-theme.ts with TERMINAL_THEME constant | Theme now easily configurable |
