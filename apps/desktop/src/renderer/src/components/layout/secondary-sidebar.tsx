import { Button } from "@vibest/ui/components/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import type { DiffFileInfo, Worktree } from "../../types";

import { useDiffStats } from "../../hooks/use-diff-stats";
import { buildFileTree } from "../../utils/build-file-tree";
import { DiffFileTree } from "../worktrees/diff-file-tree";

interface SecondarySidebarProps {
  worktree: Worktree | null;
  selectedPath?: string;
  onFileSelect: (file: DiffFileInfo) => void;
}

export function SecondarySidebar({ worktree, selectedPath, onFileSelect }: SecondarySidebarProps) {
  const { data: diffStats, isLoading, error, refetch } = useDiffStats(worktree?.path);

  const allFiles = useMemo(() => diffStats?.files ?? [], [diffStats?.files]);

  const { stagedFiles, stagedCount, unstagedFiles, unstagedCount } = useMemo(() => {
    const staged = allFiles.filter((file) => file.staged);
    const unstaged = allFiles.filter((file) => !file.staged);
    return {
      stagedFiles: buildFileTree(staged),
      stagedCount: staged.length,
      unstagedFiles: buildFileTree(unstaged),
      unstagedCount: unstaged.length,
    };
  }, [allFiles]);

  const handleFileSelect = (path: string) => {
    const file = allFiles.find((item) => item.path === path);
    if (file) {
      onFileSelect(file);
    }
  };

  if (!worktree) {
    return (
      <Empty className="h-full">
        <EmptyTitle>No worktree selected A</EmptyTitle>
        <EmptyDescription>Choose a task to browse changed files.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-10 items-center justify-between border-b px-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Changed Files</p>
          <p className="text-muted-foreground truncate text-xs">{worktree.branch}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6"
          onClick={() => refetch()}
          disabled={isLoading}
          title="Refresh changes"
        >
          <RefreshCw className={isLoading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {isLoading && allFiles.length === 0 ? (
          <Empty className="h-full">
            <Spinner />
            <EmptyDescription>Loading...</EmptyDescription>
          </Empty>
        ) : error ? (
          <Empty className="h-full">
            <EmptyTitle>Error</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </Empty>
        ) : allFiles.length === 0 ? (
          <Empty className="h-full">
            <EmptyMedia variant="icon">
              <FileDiffIcon />
            </EmptyMedia>
            <EmptyTitle>No changes</EmptyTitle>
            <EmptyDescription>Working tree is clean</EmptyDescription>
          </Empty>
        ) : (
          <ScrollArea className="h-full">
            <DiffFileTree
              stagedFiles={stagedFiles}
              unstagedFiles={unstagedFiles}
              stagedCount={stagedCount}
              unstagedCount={unstagedCount}
              onFileClick={handleFileSelect}
              selectedPath={selectedPath}
            />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
