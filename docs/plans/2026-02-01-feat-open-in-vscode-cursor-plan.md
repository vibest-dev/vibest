---
title: "feat: Add Open in VSCode and Cursor to Desktop Header Menus"
type: feat
date: 2026-02-01
---

# feat: Add Open in VSCode and Cursor to Desktop Header Menus

## Overview

Add two new menu items to the desktop app header dropdown menus: "Open in VSCode" and "Open in Cursor". These appear alongside the existing "Open in Finder" and "Open Terminal" options in both the task header menu and repository header menu.

## Problem Statement / Motivation

Users currently have "Open in Finder" and "Open Terminal" actions but no quick way to open a worktree or repository directly in their preferred code editor. Since VSCode and Cursor are the most common editors for this user base, adding dedicated menu items improves workflow efficiency.

## Proposed Solution

Add two new IPC contracts (`openInVSCode` and `openInCursor`) to the fs module, implement handlers using the `code` and `cursor` CLI commands, and add corresponding menu items to the header component.

**Key decisions:**
- Separate menu items for VSCode and Cursor (not a combined dropdown)
- CLI-based execution using `execFile`
- Silent failure when CLI is not available (no toast/error)
- Header menus only (no changes to WorktreeCard)

## Technical Approach

### Files to Modify

| File | Change |
|------|--------|
| `apps/desktop/src/shared/contract/fs.ts` | Add `openInVSCode` and `openInCursor` contracts |
| `apps/desktop/src/main/ipc/router/fs.ts` | Add handlers and update router export |
| `apps/desktop/src/renderer/src/components/layout/header.tsx` | Add menu items in two locations |

### Implementation Phases

#### Phase 1: Contract Definition

**File:** `apps/desktop/src/shared/contract/fs.ts`

Add two new contract methods after `openFinder`:

```typescript
openInVSCode: oc.input(
  z.object({
    path: z.string(),
  }),
),

openInCursor: oc.input(
  z.object({
    path: z.string(),
  }),
),
```

#### Phase 2: Handler Implementation

**File:** `apps/desktop/src/main/ipc/router/fs.ts`

Add handlers following the existing `openTerminal` pattern:

```typescript
export const openInVSCode = os.openInVSCode.handler(async ({ input }) => {
  const { path } = input;

  if (process.platform === "darwin") {
    execFile("code", [path]);
  } else if (process.platform === "win32") {
    execFile("code", [path], { shell: true });
  } else {
    execFile("code", [path]);
  }
});

export const openInCursor = os.openInCursor.handler(async ({ input }) => {
  const { path } = input;

  if (process.platform === "darwin") {
    execFile("cursor", [path]);
  } else if (process.platform === "win32") {
    execFile("cursor", [path], { shell: true });
  } else {
    execFile("cursor", [path]);
  }
});
```

Update the router export:

```typescript
export const fsRouter = os.router({
  selectDir,
  openTerminal,
  openFinder,
  openInVSCode,
  openInCursor,
});
```

#### Phase 3: UI Implementation

**File:** `apps/desktop/src/renderer/src/components/layout/header.tsx`

**3a. Add import:**

```typescript
import { Code } from "lucide-react";
```

**3b. Add handlers inside the component (task context section, ~line 45):**

```typescript
const handleOpenInVSCode = () => {
  if (worktree) {
    client.fs.openInVSCode({ path: worktree.path });
  }
};

const handleOpenInCursor = () => {
  if (worktree) {
    client.fs.openInCursor({ path: worktree.path });
  }
};
```

**3c. Add menu items in Task Header menu (after "Open Terminal", ~line 119):**

```tsx
<MenuItem onClick={handleOpenInVSCode}>
  <Code className="h-4 w-4" />
  Open in VSCode
</MenuItem>
<MenuItem onClick={handleOpenInCursor}>
  <Code className="h-4 w-4" />
  Open in Cursor
</MenuItem>
```

**3d. Add handlers for repository context section (~line 155):**

```typescript
const handleRepoOpenInVSCode = () => {
  client.fs.openInVSCode({ path: repository.path });
};

const handleRepoOpenInCursor = () => {
  client.fs.openInCursor({ path: repository.path });
};
```

**3e. Add menu items in Repository Header menu (after "Open Terminal", ~line 210):**

```tsx
<MenuItem onClick={handleRepoOpenInVSCode}>
  <Code className="h-4 w-4" />
  Open in VSCode
</MenuItem>
<MenuItem onClick={handleRepoOpenInCursor}>
  <Code className="h-4 w-4" />
  Open in Cursor
</MenuItem>
```

## Acceptance Criteria

- [x] "Open in VSCode" menu item appears in task header dropdown (when worktree exists)
- [x] "Open in Cursor" menu item appears in task header dropdown (when worktree exists)
- [x] "Open in VSCode" menu item appears in repository header dropdown
- [x] "Open in Cursor" menu item appears in repository header dropdown
- [x] Clicking "Open in VSCode" launches VSCode at the correct path
- [x] Clicking "Open in Cursor" launches Cursor at the correct path
- [x] If CLI is not installed, clicking does nothing (silent failure)
- [x] Menu items use the `Code` icon from lucide-react

## Menu Structure After Implementation

**Task Header Menu:**
1. Edit Task
2. --- separator ---
3. Open in Finder
4. Open Terminal
5. **Open in VSCode** ← new
6. **Open in Cursor** ← new
7. --- separator ---
8. Archive Task

**Repository Header Menu:**
1. Open in Finder
2. Open Terminal
3. **Open in VSCode** ← new
4. **Open in Cursor** ← new
5. --- separator ---
6. Remove Repository

## Testing

Manual testing steps:
1. Select a task with an associated worktree
2. Click the "More options" (three dots) button
3. Verify "Open in VSCode" and "Open in Cursor" appear after "Open Terminal"
4. Click "Open in VSCode" → VSCode should open at worktree path
5. Click "Open in Cursor" → Cursor should open at worktree path
6. Repeat for repository header menu
7. Test on a machine without VSCode/Cursor installed → should fail silently

## References

- Brainstorm: `docs/brainstorms/2026-02-01-open-in-vscode-cursor-brainstorm.md`
- Existing pattern: `apps/desktop/src/main/ipc/router/fs.ts:23-60` (openTerminal)
- Existing pattern: `apps/desktop/src/main/ipc/router/workspace.ts:153-170` (openWorktree with code CLI)
