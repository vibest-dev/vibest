---
status: done
priority: p1
issue_id: "002"
tags: [code-review, security, critical]
dependencies: []
---

# Command Injection in openWorktree Handler

## Problem Statement

The `openWorktree` handler uses `exec()` with a worktree path from the store. While the path comes from stored data, if the store is compromised or a malicious worktree path is registered, this enables code execution.

**Why it matters:** Command injection leading to arbitrary code execution.

## Findings

**Location:** `apps/desktop/src/main/ipc/router/workspace.ts:234-242`

```typescript
export const openWorktree = os.openWorktree.handler(async ({ input, context: { app } }) => {
  const worktree = app.store.getWorktree(worktreeId);
  // ...
  return new Promise<void>((resolve, reject) => {
    exec(`code "${worktree.path}"`, (error) => {
```

The pattern `exec(\`command "${variable}"\`)` is vulnerable to quote escaping.

## Proposed Solutions

### Option A: Use execFile (Recommended)

- **Pros:** Arguments are never shell-interpreted
- **Cons:** None
- **Effort:** Small
- **Risk:** Low

```typescript
import { execFile } from "node:child_process";
execFile("code", [worktree.path], (error) => { ... });
```

### Option B: Use VS Code's CLI module directly

- **Pros:** Avoids shell entirely
- **Cons:** More complex integration
- **Effort:** Medium
- **Risk:** Low

## Recommended Action

_(To be filled during triage)_

## Technical Details

**Affected files:**

- `apps/desktop/src/main/ipc/router/workspace.ts`

## Acceptance Criteria

- [ ] `openWorktree` uses `execFile` instead of `exec`
- [ ] VS Code opens correctly with special characters in path
- [ ] No shell interpretation of path

## Work Log

| Date       | Action                                 | Learnings                                |
| ---------- | -------------------------------------- | ---------------------------------------- |
| 2026-02-01 | Identified via code review             | Even "trusted" data should use safe APIs |
| 2026-02-01 | Fixed: replaced exec() with execFile() | Path passed as argument array element    |

## Resources

- Related to #001 (same pattern)
