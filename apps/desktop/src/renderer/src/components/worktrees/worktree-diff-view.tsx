import { Button } from "@vibest/ui/components/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { ArrowLeft, FileDiff as FileDiffIcon, PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

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
