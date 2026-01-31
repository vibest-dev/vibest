# Worktree Diff View Design

## Overview

Add a diff view to the main content area when a worktree is selected. The view shows all changed files with stacked diffs on the left and a collapsible file tree on the right using `@pierre/diffs`.

## Layout

```
┌─────────────────────────┬───────────────────────────────────────────────────────────────────────┐
│  MAIN SIDEBAR           │  MAIN CONTENT AREA                                                    │
│                         │                                                                       │
│  ▼ vibest               │  ┌─────────────────────────────────────────────────────────────────┐ │
│    ├─ main         +2-1 │  │ feature/auth-system                        +15 -8 · 5 files     │ │
│    ├─ feature/*   +15-8 │  ├─────────────────────────────────────────────────────────────────┤ │
│    └─ bugfix       +3-0 │  │                                                                 │ │
│                         │  │  ┌─ DIFFS ───────────────────────────────┬─ FILE TREE ─────[▶]┐│ │
│  ▼ other-repo           │  │  │                                       │                    ││ │
│    └─ main         +0-0 │  │  │ ┌─ src/auth.tsx ────────────────────┐ │ ▼ Staged (2)       ││ │
│                         │  │  │ │  - import { old } from 'lib'      │ │   ├─ M auth.tsx    ││ │
│                         │  │  │ │  + import { new } from 'lib'      │ │   └─ A button.tsx  ││ │
│                         │  │  │ └───────────────────────────────────┘ │                    ││ │
│                         │  │  │                                       │ ▼ Unstaged (3)     ││ │
│                         │  │  │ ┌─ src/button.tsx ──────────────────┐ │   ├─ M utils.ts    ││ │
│                         │  │  │ │  + new file content               │ │   ├─ D old.ts      ││ │
│                         │  │  │ └───────────────────────────────────┘ │   └─ M test.ts     ││ │
│                         │  │  │                                       │                    ││ │
│                         │  │  │ ┌─ src/utils.ts ────────────────────┐ │                    ││ │
│                         │  │  │ │  - const x = 1                    │ │                    ││ │
│                         │  │  │ │  + const x = 2                    │ │                    ││ │
│                         │  │  │ └───────────────────────────────────┘ │                    ││ │
│                         │  │  │                                       │                    ││ │
│                         │  │  └───────────────────────────────────────┴────────────────────┘│ │
│                         │  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

## States

### 1. Normal (File Tree Expanded)

- Diffs stacked vertically on left side
- File tree visible on right side
- Click file in tree → smooth scroll to that diff
- Collapse button `[▶]` in file tree header

### 2. File Tree Collapsed

```
┌─ DIFFS (full width) ────────────────────────────────────────────────────────────┬[◀]┐
│                                                                                 │   │
│ ┌─ src/auth.tsx ──────────────────────────────────────────────────────────────┐ │   │
│ │  - import { old } from 'lib'                                                │ │   │
│ │  + import { new } from 'lib'                                                │ │   │
│ └─────────────────────────────────────────────────────────────────────────────┘ │   │
└─────────────────────────────────────────────────────────────────────────────────┴───┘
```

- File tree hidden, only toggle button `[◀]` visible on right edge
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
2. **`DiffFileTree`** - Collapsible file tree with Staged/Unstaged sections (right side)
3. **`DiffContent`** - Scrollable container with all diffs (left side)

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
DiffContent   DiffFileTree
(@pierre/diffs) (file tree)
  ↑                  ↓
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
