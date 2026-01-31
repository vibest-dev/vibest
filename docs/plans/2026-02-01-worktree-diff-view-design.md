# Worktree Diff View Design

## Overview

Add a diff view to the main content area when a worktree is selected. The view shows all changed files with a collapsible file tree on the left and stacked diffs on the right using `@pierre/diffs`.

## Layout

```
┌─────────────────────────┬───────────────────────────────────────────────────────────────────────┐
│  MAIN SIDEBAR           │  MAIN CONTENT AREA                                                    │
│                         │                                                                       │
│  ▼ vibest               │  ┌─────────────────────────────────────────────────────────────────┐ │
│    ├─ main         +2-1 │  │ feature/auth-system                        +15 -8 · 5 files     │ │
│    ├─ feature/*   +15-8 │  ├─────────────────────────────────────────────────────────────────┤ │
│    └─ bugfix       +3-0 │  │                                                                 │ │
│                         │  │  ┌─ FILE TREE ─────[◀]┬─ DIFFS ───────────────────────────────┐│ │
│  ▼ other-repo           │  │  │                    │                                       ││ │
│    └─ main         +0-0 │  │  │ ▼ Staged (2)       │ ┌─ src/auth.tsx ────────────────────┐││ │
│                         │  │  │   ├─ M auth.tsx    │ │  - import { old } from 'lib'      │││ │
│                         │  │  │   └─ A button.tsx  │ │  + import { new } from 'lib'      │││ │
│                         │  │  │                    │ └───────────────────────────────────┘││ │
│                         │  │  │ ▼ Unstaged (3)     │                                       ││ │
│                         │  │  │   ├─ M utils.ts    │ ┌─ src/button.tsx ──────────────────┐││ │
│                         │  │  │   ├─ D old.ts      │ │  + new file content               │││ │
│                         │  │  │   └─ M test.ts     │ └───────────────────────────────────┘││ │
│                         │  │  │                    │                                       ││ │
│                         │  │  └────────────────────┴───────────────────────────────────────┘│ │
│                         │  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

## States

### 1. Normal (File Tree Expanded)

- File tree visible on left side
- Diffs stacked vertically on right side
- Click file in tree → smooth scroll to that diff
- Collapse button `[◀]` in file tree header

### 2. File Tree Collapsed

- File tree hidden, only toggle button `[▶]` visible
- Diffs expand to full width
- Click toggle to expand file tree

### 3. No Worktree Selected

- Empty state: "Select a worktree to view changes"

### 4. Clean Worktree (No Changes)

- Header shows branch name
- Message: "No changes in this worktree"

## File Tree Structure

Two collapsible sections:

```
▼ Staged Changes (2)
  ▼ src/
    └─ M auth.tsx

▼ Unstaged Changes (3)
  ▼ src/
    ├─ M utils.ts
    └─ A button.tsx
  ▼ tests/
    └─ M auth.test.ts
```

### File Status Badges

| Badge | Status   | Color        |
|-------|----------|--------------|
| M     | Modified | Yellow/Amber |
| A     | Added    | Green        |
| D     | Deleted  | Red          |
| R     | Renamed  | Blue         |

## Diff Rendering

- Use `@pierre/diffs` React components
- `MultiFileDiff` for rendering all diffs at once
- Syntax highlighting via Shiki (built-in)
- Theme matches app theme (light/dark)

### Scroll Behavior

- Each file diff section has an `id` attribute for scroll targeting
- Click file in tree → `scrollIntoView({ behavior: 'smooth' })`
- Active file highlighted in tree while scrolled into view

## Technical Implementation

### New Components

1. **`WorktreeDiffView`** - Main container for the diff view
2. **`DiffFileTree`** - Collapsible file tree with Staged/Unstaged sections
3. **`DiffContent`** - Scrollable container with all diffs

### Data Flow

```
Selected Worktree (from sidebar)
         ↓
  useDiff(path) hook
         ↓
    DiffResult
         ↓
  ┌──────┴──────┐
  ↓             ↓
DiffFileTree   DiffContent
(file tree)    (@pierre/diffs)
  ↓                  ↑
  └── scrollToFile ──┘
```

### Files to Create/Modify

**New files:**
- `apps/desktop/src/renderer/src/components/worktrees/worktree-diff-view.tsx`
- `apps/desktop/src/renderer/src/components/worktrees/diff-file-tree.tsx`
- `apps/desktop/src/renderer/src/components/worktrees/diff-content.tsx`

**Modify:**
- `apps/desktop/src/renderer/src/App.tsx` - Render `WorktreeDiffView` in main content when worktree selected

### Reuse Existing

- `useDiff` hook - Already fetches diff data
- `DiffResult` type - Already defines file diff structure
- `@pierre/diffs` - Already installed and used in `DiffViewer`

### File Tree Data Transformation

Transform flat file list to nested tree:

```typescript
// Input: FileDiff[]
[
  { path: 'src/auth.tsx', status: 'modified' },
  { path: 'src/utils.ts', status: 'modified' },
  { path: 'tests/auth.test.ts', status: 'modified' },
]

// Output: TreeNode[]
[
  {
    name: 'src',
    type: 'folder',
    children: [
      { name: 'auth.tsx', type: 'file', status: 'modified', path: 'src/auth.tsx' },
      { name: 'utils.ts', type: 'file', status: 'modified', path: 'src/utils.ts' },
    ]
  },
  {
    name: 'tests',
    type: 'folder',
    children: [
      { name: 'auth.test.ts', type: 'file', status: 'modified', path: 'tests/auth.test.ts' },
    ]
  }
]
```

## Dependencies

- `@pierre/diffs` - Already in project, used for diff rendering
- No new dependencies required
