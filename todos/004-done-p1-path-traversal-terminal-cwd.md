---
status: done
priority: p1
issue_id: "004"
tags: [code-review, security, terminal]
dependencies: []
---

# Path Traversal in Terminal cwd Parameter

## Problem Statement

The `cwd` parameter for terminal creation is validated only with `fs.existsSync()`, which does not prevent path traversal attacks. An attacker can spawn a terminal in any accessible directory on the system.

**Why it matters:** Unauthorized file system access. Combined with the terminal, users can browse, read, and modify files anywhere they have permissions.

## Findings

**Location:** `apps/desktop/src/main/terminal/terminal-manager.ts:88-107`

```typescript
create(worktreeId: string, cwd: string): TerminalInstance {
  if (!fs.existsSync(cwd)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }
  // ... spawns shell in ANY existing directory
  const ptyProcess = pty.spawn(shell, [], {
    cwd,  // <-- Unvalidated path
```

**Contract has no validation:** `apps/desktop/src/shared/contract/terminal.ts:30-36`
```typescript
create: oc.input(z.object({
  worktreeId: z.string(),
  cwd: z.string(),  // No path validation schema
})),
```

**Exploit:** `terminal.create({ worktreeId: "x", cwd: "/" })` spawns shell in root.

## Proposed Solutions

### Option A: Validate cwd against worktree path (Recommended)
- **Pros:** Terminals can only be created in registered worktree directories
- **Cons:** Requires lookup of worktree by ID
- **Effort:** Small
- **Risk:** Low

```typescript
create(worktreeId: string, cwd: string): TerminalInstance {
  const worktree = this.store.getWorktree(worktreeId);
  if (!worktree) throw new Error("Invalid worktreeId");

  const resolvedCwd = path.resolve(cwd);
  const worktreePath = path.resolve(worktree.path);

  if (!resolvedCwd.startsWith(worktreePath)) {
    throw new Error("cwd must be within worktree directory");
  }
  // ...
}
```

### Option B: Validate against vibest workspace root
- **Pros:** Allows subdirectories within workspace
- **Cons:** Less restrictive than Option A
- **Effort:** Small
- **Risk:** Low

### Option C: Add Zod path validation in contract
- **Pros:** Validates at contract level
- **Cons:** Still needs runtime check
- **Effort:** Small
- **Risk:** Low (defense in depth)

## Recommended Action

*(To be filled during triage)*

## Technical Details

**Affected files:**
- `apps/desktop/src/main/terminal/terminal-manager.ts`
- `apps/desktop/src/shared/contract/terminal.ts`

## Acceptance Criteria

- [ ] `cwd` validated to be within worktree directory
- [ ] Path traversal attempts (e.g., `../../`) rejected
- [ ] Symlink resolution handled
- [ ] Error message does not leak path information

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-01 | Identified via code review | fs.existsSync is not a security check |
| 2026-02-01 | Fixed: validate cwd against worktree path with path.resolve and startsWith check | Defense at router layer where store is accessible |

## Resources

- [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)
