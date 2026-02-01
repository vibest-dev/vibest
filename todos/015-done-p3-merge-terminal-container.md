---
status: done
priority: p3
issue_id: "015"
tags: [code-review, simplification, architecture]
dependencies: ["011"]
---

# Merge TerminalContainer into TerminalTabs

## Problem Statement

`TerminalContainer` is a thin wrapper that just combines `TerminalTabs` and `TerminalView[]`. It duplicates the terminal query (see #011) and adds unnecessary component hierarchy.

## Findings

**Location:** `apps/desktop/src/renderer/src/components/terminal/terminal-container.tsx` (54 lines)

The component:

- Queries terminals (duplicated in TerminalTabs)
- Renders TerminalTabs
- Renders TerminalView for each terminal
- Handles visibility

## Proposed Solutions

### Merge into renamed TerminalPanel

1. Rename `TerminalTabs` to `TerminalPanel`
2. Move TerminalView rendering into it
3. Delete `TerminalContainer`
4. Update exports and imports

**Impact:** -54 lines, simpler hierarchy

## Acceptance Criteria

- [ ] TerminalContainer deleted
- [ ] TerminalPanel handles tabs and views
- [ ] Single terminal list query
- [ ] All functionality preserved

## Work Log

| Date       | Action                                                                   | Learnings                     |
| ---------- | ------------------------------------------------------------------------ | ----------------------------- |
| 2026-02-01 | Identified via code review                                               | Avoid thin wrapper components |
| 2026-02-01 | Fixed: created TerminalPanel, deleted TerminalContainer and TerminalTabs | Combined with #011 fix        |
