# Worktree Diff View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a diff view to the main content area showing all diffs on the left with a collapsible file tree on the right.

**Architecture:** Replace the current single-file diff viewer with a multi-file view. Diffs render stacked on the left using `@pierre/diffs`. File tree on the right shows Staged/Unstaged sections with click-to-scroll navigation.

**Tech Stack:** React, `@pierre/diffs`, Tailwind CSS, lucide-react icons, existing Collapsible component

---

## Task 1: Create buildFileTree Utility

**Files:**

- Create: `apps/desktop/src/renderer/src/utils/build-file-tree.ts`

**Step 1: Create the utility file with types and function**

```typescript
import type { FileDiff } from "../types";

export interface FileTreeNode {
  path: string; // "src/components/auth.tsx" or "src/components"
  isDirectory: boolean;
  status?: FileDiff["status"]; // only for files
  fileIndex?: number; // only for files
  children: FileTreeNode[];
}

export function buildFileTree(files: FileDiff[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filename = file.newFile?.filename ?? file.oldFile?.filename;
    if (!filename) continue;

    const parts = filename.split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isLast = j === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let existing = currentLevel.find((n) => n.path === currentPath);

      if (!existing) {
        existing = {
          path: currentPath,
          isDirectory: !isLast,
          children: [],
          ...(isLast ? { status: file.status, fileIndex: i } : {}),
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: directories first, then alphabetically by name
  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        const nameA = a.path.split("/").pop() ?? "";
        const nameB = b.path.split("/").pop() ?? "";
        return nameA.localeCompare(nameB);
      })
      .map((node) => ({
        ...node,
        children: sortNodes(node.children),
      }));
  };

  return sortNodes(root);
}
```

**Step 2: Verify the file was created correctly**

Run: `cat apps/desktop/src/renderer/src/utils/build-file-tree.ts | head -20`
Expected: Shows the imports and interface definition

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/build-file-tree.ts
git commit -m "feat(desktop): add buildFileTree utility for diff file tree"
```

---

## Task 2: Create DiffFileTree Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/worktrees/diff-file-tree.tsx`

**Step 1: Create the file tree component**

```typescript
import { Badge } from "@vibest/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";

import type { FileDiff } from "../../types";
import type { FileTreeNode } from "../../utils/build-file-tree";

const statusVariants: Record<FileDiff["status"], "warning" | "success" | "error" | "info"> = {
  modified: "warning",
  added: "success",
  deleted: "error",
  renamed: "info",
};

const statusLabels: Record<FileDiff["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
};

interface DiffFileTreeProps {
  stagedFiles: FileTreeNode[];
  unstagedFiles: FileTreeNode[];
  onFileClick: (fileIndex: number) => void;
}

interface TreeNodeProps {
  node: FileTreeNode;
  level: number;
  onFileClick: (fileIndex: number) => void;
}

function TreeNode({ node, level, onFileClick }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(true);
  const paddingLeft = level * 12;
  const name = node.path.split("/").pop() ?? "";

  if (node.isDirectory) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger
          className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1"
          style={{ paddingLeft }}
        >
          <ChevronRight
            className={`text-muted-foreground size-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          {isOpen ? (
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <Folder className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="truncate text-sm">{name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} level={level + 1} onFileClick={onFileClick} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <button
      type="button"
      className="hover:bg-accent/50 flex w-full items-center gap-2 rounded px-2 py-1"
      style={{ paddingLeft: paddingLeft + 14 }}
      onClick={() => node.fileIndex !== undefined && onFileClick(node.fileIndex)}
    >
      <File className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-sm">{name}</span>
      {node.status && (
        <Badge variant={statusVariants[node.status]} size="sm" className="shrink-0">
          {statusLabels[node.status]}
        </Badge>
      )}
    </button>
  );
}

export function DiffFileTree({ stagedFiles, unstagedFiles, onFileClick }: DiffFileTreeProps) {
  const hasStagedFiles = stagedFiles.length > 0;
  const hasUnstagedFiles = unstagedFiles.length > 0;

  return (
    <div className="flex flex-col gap-2 p-2">
      {hasStagedFiles && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1 font-medium">
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
            <span className="text-sm">Staged Changes</span>
            <span className="text-muted-foreground ml-auto text-xs">{stagedFiles.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {stagedFiles.map((node) => (
              <TreeNode key={node.path} node={node} level={1} onFileClick={onFileClick} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {hasUnstagedFiles && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1 font-medium">
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
            <span className="text-sm">Unstaged Changes</span>
            <span className="text-muted-foreground ml-auto text-xs">{unstagedFiles.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {unstagedFiles.map((node) => (
              <TreeNode key={node.path} node={node} level={1} onFileClick={onFileClick} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {!hasStagedFiles && !hasUnstagedFiles && (
        <p className="text-muted-foreground px-2 py-4 text-center text-sm">No changes</p>
      )}
    </div>
  );
}
```

**Step 2: Verify the file was created correctly**

Run: `cat apps/desktop/src/renderer/src/components/worktrees/diff-file-tree.tsx | head -30`
Expected: Shows the imports and interfaces

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/worktrees/diff-file-tree.tsx
git commit -m "feat(desktop): add DiffFileTree component for staged/unstaged sections"
```

---

## Task 3: Create DiffContent Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/worktrees/diff-content.tsx`

**Step 1: Create the diff content component**

```typescript
import { Spinner } from "@vibest/ui/components/spinner";
import { lazy, Suspense, useEffect, useRef } from "react";

import type { FileDiff } from "../../types";

const LazyMultiFileDiff = lazy(() =>
  import("@pierre/diffs/react").then((mod) => ({ default: mod.MultiFileDiff })),
);

interface DiffContentProps {
  files: FileDiff[];
  scrollToIndex: number | null;
}

export function DiffContent({ files, scrollToIndex }: DiffContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (scrollToIndex !== null && fileRefs.current.has(scrollToIndex)) {
      const element = fileRefs.current.get(scrollToIndex);
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollToIndex]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-4 p-4">
      {files.map((file, index) => {
        const filename = file.newFile?.filename ?? file.oldFile?.filename ?? "unknown";

        return (
          <div
            key={filename}
            ref={(el) => {
              if (el) fileRefs.current.set(index, el);
            }}
            className="border-border overflow-hidden rounded-lg border"
          >
            <div className="bg-muted/50 border-border border-b px-3 py-2">
              <span className="font-mono text-sm">{filename}</span>
            </div>
            <Suspense fallback={<div className="flex justify-center p-4"><Spinner /></div>}>
              <LazyMultiFileDiff
                oldFile={
                  file.oldFile
                    ? { name: file.oldFile.filename, contents: file.oldFile.contents }
                    : { name: "", contents: "" }
                }
                newFile={
                  file.newFile
                    ? { name: file.newFile.filename, contents: file.newFile.contents }
                    : { name: "", contents: "" }
                }
                options={{
                  themeType: "dark",
                  diffStyle: "unified",
                }}
              />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Verify the file was created correctly**

Run: `cat apps/desktop/src/renderer/src/components/worktrees/diff-content.tsx | head -30`
Expected: Shows the imports and interface

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/worktrees/diff-content.tsx
git commit -m "feat(desktop): add DiffContent component for rendering all diffs"
```

---

## Task 4: Create WorktreeDiffView Component

**Files:**

- Create: `apps/desktop/src/renderer/src/components/worktrees/worktree-diff-view.tsx`

**Step 1: Create the main worktree diff view component**

```typescript
import { Button } from "@vibest/ui/components/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { ArrowLeft, FileDiff as FileDiffIcon, PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Worktree } from "../../types";

import { useDiff } from "../../hooks/use-diff";
import { buildFileTree } from "../../utils/build-file-tree";
import { DiffContent } from "./diff-content";
import { DiffFileTree } from "./diff-file-tree";

interface WorktreeDiffViewProps {
  worktree: Worktree;
  onClose: () => void;
}

export function WorktreeDiffView({ worktree, onClose }: WorktreeDiffViewProps) {
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false);
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null);

  // Fetch both staged and unstaged diffs
  const { diff: allDiff, isLoading: isLoadingAll, error: errorAll, refresh: refreshAll } = useDiff({
    path: worktree.path,
    staged: false,
  });

  const { diff: stagedDiff, isLoading: isLoadingStaged, refresh: refreshStaged } = useDiff({
    path: worktree.path,
    staged: true,
  });

  const isLoading = isLoadingAll || isLoadingStaged;
  const error = errorAll;

  // Build file trees
  const stagedFiles = useMemo(
    () => buildFileTree(stagedDiff?.files ?? []),
    [stagedDiff?.files],
  );

  const unstagedFiles = useMemo(() => {
    const allFiles = allDiff?.files ?? [];
    const stagedPaths = new Set(
      (stagedDiff?.files ?? []).map(
        (f) => f.newFile?.filename ?? f.oldFile?.filename,
      ),
    );
    const unstaged = allFiles.filter((f) => {
      const path = f.newFile?.filename ?? f.oldFile?.filename;
      return !stagedPaths.has(path);
    });
    return buildFileTree(unstaged);
  }, [allDiff?.files, stagedDiff?.files]);

  const allFiles = allDiff?.files ?? [];
  const stats = allDiff?.stats;

  // Refresh on mount
  useEffect(() => {
    refreshAll();
    refreshStaged();
  }, [refreshAll, refreshStaged]);

  const handleFileClick = (fileIndex: number) => {
    setScrollToIndex(fileIndex);
    // Reset after scroll animation
    setTimeout(() => setScrollToIndex(null), 500);
  };

  const handleRefresh = () => {
    refreshAll();
    refreshStaged();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <ArrowLeft />
          </Button>
          <div>
            <h2 className="text-sm font-semibold">{worktree.branch}</h2>
            {stats && (
              <p className="text-muted-foreground text-xs">
                <span className="text-success">+{stats.insertions}</span>
                {" "}
                <span className="text-destructive">-{stats.deletions}</span>
                {" · "}
                {stats.filesChanged} files
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isLoading}>
            <RefreshCw className={isLoading ? "animate-spin" : ""} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsTreeCollapsed(!isTreeCollapsed)}
          >
            {isTreeCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1">
        {isLoading && allFiles.length === 0 ? (
          <Empty className="flex-1">
            <Spinner />
            <EmptyDescription>Loading...</EmptyDescription>
          </Empty>
        ) : error ? (
          <Empty className="flex-1">
            <EmptyTitle>Error</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </Empty>
        ) : allFiles.length === 0 ? (
          <Empty className="flex-1">
            <EmptyMedia variant="icon">
              <FileDiffIcon />
            </EmptyMedia>
            <EmptyTitle>No changes</EmptyTitle>
            <EmptyDescription>Working tree is clean</EmptyDescription>
          </Empty>
        ) : (
          <>
            {/* Diffs (left side) */}
            <ScrollArea className="flex-1">
              <DiffContent files={allFiles} scrollToIndex={scrollToIndex} />
            </ScrollArea>

            {/* File Tree (right side, collapsible) */}
            {!isTreeCollapsed && (
              <ScrollArea className="border-border w-64 shrink-0 border-l">
                <DiffFileTree
                  stagedFiles={stagedFiles}
                  unstagedFiles={unstagedFiles}
                  onFileClick={handleFileClick}
                />
              </ScrollArea>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify the file was created correctly**

Run: `cat apps/desktop/src/renderer/src/components/worktrees/worktree-diff-view.tsx | head -40`
Expected: Shows the imports and interfaces

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/worktrees/worktree-diff-view.tsx
git commit -m "feat(desktop): add WorktreeDiffView component with collapsible file tree"
```

---

## Task 5: Update App.tsx to Use New Component

**Files:**

- Modify: `apps/desktop/src/renderer/src/App.tsx`

**Step 1: Update the import**

Change line 14 from:

```typescript
import { DiffViewer } from "./components/worktrees/diff-viewer";
```

To:

```typescript
import { WorktreeDiffView } from "./components/worktrees/worktree-diff-view";
```

**Step 2: Update the component usage**

Change lines 172-173 from:

```typescript
{diffWorktree ? (
  <DiffViewer worktree={diffWorktree} onClose={() => setDiffWorktree(null)} />
```

To:

```typescript
{diffWorktree ? (
  <WorktreeDiffView worktree={diffWorktree} onClose={() => setDiffWorktree(null)} />
```

**Step 3: Verify the changes**

Run: `grep -n "WorktreeDiffView\|DiffViewer" apps/desktop/src/renderer/src/App.tsx`
Expected: Shows `WorktreeDiffView` import and usage, no `DiffViewer` references

**Step 4: Run typecheck to verify**

Run: `cd apps/desktop && pnpm typecheck`
Expected: No type errors

**Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(desktop): replace DiffViewer with WorktreeDiffView in App"
```

---

## Task 6: Manual Testing

**Step 1: Start the development server**

Run: `cd apps/desktop && pnpm dev`

**Step 2: Test the diff view**

1. Select a worktree with changes from the sidebar
2. Verify the diff view shows:
   - Header with branch name and stats (+X -Y · N files)
   - All diffs stacked on the left
   - File tree on the right with Staged/Unstaged sections
3. Click a file in the tree → verify it scrolls to that diff
4. Click the collapse button → verify file tree hides and diffs expand
5. Click the expand button → verify file tree reappears
6. Click refresh → verify diffs reload

**Step 3: Test edge cases**

1. Select a clean worktree (no changes) → verify "No changes" message
2. Select a worktree with only staged changes → verify only Staged section shows
3. Select a worktree with only unstaged changes → verify only Unstaged section shows

**Step 4: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix(desktop): address diff view issues from testing"
```

---

## Task 7: Final Cleanup

**Step 1: Run linting**

Run: `pnpm lint`
Expected: No lint errors in the new files

**Step 2: Run typecheck for entire project**

Run: `pnpm typecheck`
Expected: No type errors

**Step 3: Create final commit if there are any uncommitted changes**

```bash
git status
# If there are changes:
git add -A
git commit -m "chore(desktop): final cleanup for worktree diff view"
```

---

## Summary

| Task | Description                       | Files                                         |
| ---- | --------------------------------- | --------------------------------------------- |
| 1    | Create buildFileTree utility      | `utils/build-file-tree.ts`                    |
| 2    | Create DiffFileTree component     | `components/worktrees/diff-file-tree.tsx`     |
| 3    | Create DiffContent component      | `components/worktrees/diff-content.tsx`       |
| 4    | Create WorktreeDiffView component | `components/worktrees/worktree-diff-view.tsx` |
| 5    | Update App.tsx                    | `App.tsx`                                     |
| 6    | Manual testing                    | -                                             |
| 7    | Final cleanup                     | -                                             |

**Total new files:** 4
**Modified files:** 1
