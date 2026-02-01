---
date: 2026-02-01
topic: task-worktree-model
---

# Task and Worktree Data Model Design

## What We're Building

Redesign Homer's core data model with **Task** as the primary dimension, replacing the current direct Worktree display approach.

Core relationship:

```
Repository 1:N Task 1:N Worktree 1:1 Branch
```

Users see a Task list in the UI. Each Task can have multiple Worktrees (for parallel experimentation), but the current UI treats it as 1:1.

## Why This Approach

**Problems:**

- Worktrees are created with random branch names (e.g., city names like `tokyo`)
- Users rename branches to meaningful names after starting work
- Current UI displays Worktrees directly, lacking task semantics
- Users may work on multiple projects in parallel, need clear task management view

**Why Task as the primary dimension:**

- Task names are user-defined, stable and meaningful
- Branch names may change, not suitable as primary identifier
- Supports future scenario of one Task with multiple Worktrees (parallel experimentation)
- Better matches user mental model: working on "tasks", not "managing worktrees"

**Why Worktree is stored separately instead of embedded in Task:**

- Smaller impact on existing code
- Data structure supports 1:N now, UI treats as 1:1 for now
- No data migration needed for future expansion

## Data Model

### Repository

```typescript
interface Repository {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  labels: Label[]; // Repository-level label definitions
}
```

### Label

```typescript
interface Label {
  name: string; // Unique identifier, supports any characters (spaces, unicode, emoji)
  color: string; // Hex color value
  description?: string;
}
```

Default labels created when adding a new Repository:

```typescript
const DEFAULT_LABELS: Label[] = [
  { name: "todo", color: "#e4e669", description: "Not started" },
  { name: "progress", color: "#0075ca", description: "In progress" },
  { name: "review", color: "#a2eeef", description: "Pending review" },
  { name: "done", color: "#0e8a16", description: "Completed" },
  { name: "cancelled", color: "#6e7681", description: "Cancelled" },
  { name: "bug", color: "#d73a4a", description: "Bug fix" },
  { name: "feature", color: "#a2eeef", description: "New feature" },
  { name: "refactor", color: "#d4c5f9", description: "Refactoring" },
];
```

### Task

```typescript
interface Task {
  id: string;
  repositoryId: string;
  name: string;
  description?: string;
  labels: string[]; // References Label.name
  createdAt: number;
  updatedAt: number;
}
```

**Design decisions:**

- Use labels array (strings) referencing Label.name, similar to GitHub Issues
- No status field, status is represented by labels (e.g., `todo`, `progress`, `done`)
- Sorting handled at UI layer (by creation time)

### Worktree

```typescript
interface Worktree {
  id: string;
  repositoryId: string;
  taskId: string; // Associated Task
  path: string;
  branch: string; // Current branch name
}
```

**Worktree and Branch 1:1 relationship:**

- Git limitation: same branch cannot be checked out in multiple worktrees
- Therefore each Worktree must correspond to a unique branch
- Task 1:N Worktree means Task can have multiple branches (parallel experimentation)

**Runtime fields (not stored, read from Git in real-time):**

```typescript
interface WorktreeRuntime extends Worktree {
  exists: boolean; // Whether worktree path exists
  currentBranch: string; // git rev-parse --abbrev-ref HEAD
  hasChanges: boolean; // git status --porcelain
  ahead: number; // Commits ahead of remote
  behind: number; // Commits behind remote
}
```

**Branch sync strategy:**

- `branch` records current branch name
- Sync reads actual branch name from Git and updates
- User renaming (`git branch -m`) or switching (`git checkout`) will be reflected
- Cannot 100% distinguish rename vs switch, treat both as "update" for now
- Future: Agent can trigger sync after renaming branch

### Store Schema

```typescript
interface StoreSchema {
  repositories: Repository[];
  tasks: Task[];
  worktrees: StoredWorktree[];
}
```

Centralized storage at `~/Library/Application Support/homer/store.json`

## UI Design

### Sidebar Structure

```
▼ vibest (Repository)
  ● Fix payment flow (Task)     ← Click to open corresponding Worktree
  ● Add export feature (Task)
  ○ Refactor user module (paused) ← Status differentiated by labels
  ➕ New task

▼ my-app (Repository)
  ● Auth refactor (Task)
  ➕ New task

➕ Add project
```

### Future Extension (Task 1:N Worktree)

```
▼ vibest
  ▼ Fix payment flow            ← Expand to show multiple Worktrees
    ├ tokyo (Approach A)
    └ osaka (Approach B)
```

## Key Decisions

| Decision                              | Choice           | Rationale                                          |
| ------------------------------------- | ---------------- | -------------------------------------------------- |
| Task vs Worktree as primary dimension | Task             | Users care about tasks, not worktree details       |
| Worktree embedded vs separate         | Separate storage | Smaller code impact, supports future 1:N           |
| Task status field vs labels           | Labels           | More flexible, users can customize status workflow |
| Label reference method                | By name          | Simple, similar to GitHub Issues                   |
| Label scope                           | Repository level | Each repo can have different label systems         |
| Branch sync strategy                  | Sync on read     | Simple, no edge cases                              |

## Future Features

1. **Agent sync mechanism**: Agent notifies app after renaming branch
2. **Task 1:N Worktree UI**: Creating, switching, deleting multiple Worktrees per Task

## Next Steps

→ `/workflows:plan` for implementation details
