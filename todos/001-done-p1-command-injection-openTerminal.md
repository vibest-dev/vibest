---
status: done
priority: p1
issue_id: "001"
tags: [code-review, security, critical]
dependencies: []
---

# Command Injection in openTerminal Handler

## Problem Statement

The `openTerminal` handler in `fs.ts` passes user-controlled `path` directly to `exec()` without sanitization. While quotes are used on macOS, they can be bypassed. The Windows path has NO quotes at all, making injection trivial.

**Why it matters:** Remote code execution with full system privileges. An attacker can execute arbitrary shell commands.

## Findings

**Location:** `apps/desktop/src/main/ipc/router/fs.ts:23-40`

```typescript
export const openTerminal = os.openTerminal.handler(async ({ input }) => {
  const { path } = input;

  if (process.platform === "darwin") {
    exec(`open -a Terminal "${path}"`);  // Quotes can be escaped
  }
  else if (process.platform === "win32") {
    exec(`start cmd /K "cd /d ${path}"`);  // NO QUOTES on path!
  }
```

**Exploit examples:**

- macOS: `path = '"; rm -rf / #'`
- Windows: `path = '& del /s /q C:\\ &'`

## Proposed Solutions

### Option A: Use execFile with argument arrays (Recommended)

- **Pros:** Eliminates injection entirely, arguments are never shell-interpreted
- **Cons:** Requires restructuring the command
- **Effort:** Small
- **Risk:** Low

```typescript
import { execFile } from "node:child_process";

if (process.platform === "darwin") {
  execFile("open", ["-a", "Terminal", path]);
}
```

### Option B: Validate path against allowlist

- **Pros:** Defense in depth
- **Cons:** Still uses exec, requires maintaining allowlist
- **Effort:** Medium
- **Risk:** Medium (allowlist could miss cases)

### Option C: Use spawn instead of exec

- **Pros:** Similar to execFile, arguments passed as array
- **Cons:** Slightly more complex API
- **Effort:** Small
- **Risk:** Low

## Recommended Action

_(To be filled during triage)_

## Technical Details

**Affected files:**

- `apps/desktop/src/main/ipc/router/fs.ts`

**Database changes:** None

## Acceptance Criteria

- [ ] `openTerminal` uses `execFile` or `spawn` with argument arrays
- [ ] Path injection attempts are blocked
- [ ] Functionality works on macOS and Windows
- [ ] Security test added for injection attempts

## Work Log

| Date       | Action                                         | Learnings                                              |
| ---------- | ---------------------------------------------- | ------------------------------------------------------ |
| 2026-02-01 | Identified via code review                     | Command injection via exec() is a common vulnerability |
| 2026-02-01 | Fixed: replaced exec() with execFile()/spawn() | Arguments passed as array are never shell-interpreted  |

## Resources

- [OWASP Command Injection](https://owasp.org/www-community/attacks/Command_Injection)
- [Node.js child_process security](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
