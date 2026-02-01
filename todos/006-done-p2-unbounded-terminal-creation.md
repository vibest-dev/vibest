---
status: done
priority: p2
issue_id: "006"
tags: [code-review, security, performance]
dependencies: []
---

# Unbounded Terminal Creation (Resource Exhaustion)

## Problem Statement

There is no limit on the number of terminals that can be created. An attacker or buggy client could create hundreds of PTY processes, exhausting system resources.

## Findings

**Location:** `apps/desktop/src/main/terminal/terminal-manager.ts:83-138`

The `create()` method has no guards on terminal count.

## Proposed Solutions

### Option A: Add per-worktree and global limits (Recommended)

- **Effort:** Small
- **Risk:** Low

```typescript
private readonly MAX_TERMINALS_PER_WORKTREE = 10;
private readonly MAX_TERMINALS_GLOBAL = 50;

create(worktreeId: string, cwd: string): TerminalInstance {
  if (this.terminals.size >= this.MAX_TERMINALS_GLOBAL) {
    throw new Error("Maximum terminal limit reached");
  }
  if (this.getTerminalsByWorktree(worktreeId).length >= this.MAX_TERMINALS_PER_WORKTREE) {
    throw new Error("Maximum terminals per worktree reached");
  }
  // ...
}
```

## Acceptance Criteria

- [ ] Global terminal limit enforced
- [ ] Per-worktree limit enforced
- [ ] Clear error message when limit reached
- [ ] UI shows limit status

## Work Log

| Date       | Action                                                                            | Learnings                          |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| 2026-02-01 | Identified via code review                                                        | Resource limits prevent DoS        |
| 2026-02-01 | Fixed: added MAX_TERMINALS_GLOBAL (50) and MAX_TERMINALS_PER_WORKTREE (10) limits | Check before creating new terminal |
