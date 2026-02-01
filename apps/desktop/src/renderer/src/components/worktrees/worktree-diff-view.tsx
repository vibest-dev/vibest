import { Button } from "@vibest/ui/components/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { ArrowLeft, FileDiff as FileDiffIcon, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { DiffFileInfo, Worktree } from "../../types";

import { useDiffStats } from "../../hooks/use-diff-stats";
import { buildFileTree } from "../../utils/build-file-tree";
import { DiffFileTree } from "./diff-file-tree";
import { SingleFileDiff } from "./single-file-diff";

interface WorktreeDiffViewProps {
  worktree: Worktree;
  onClose: () => void;
}

export function WorktreeDiffView({ worktree, onClose }: WorktreeDiffViewProps) {
  const [selectedFile, setSelectedFile] = useState<DiffFileInfo | null>(null);

  const { data: diffStats, isLoading, error, refetch } = useDiffStats(worktree.path);

  const allFiles = useMemo(() => diffStats?.files ?? [], [diffStats?.files]);

  // Build file trees from stats
  const { stagedFiles, stagedCount, unstagedFiles, unstagedCount } = useMemo(() => {
    const staged = allFiles.filter((f) => f.staged);
    const unstaged = allFiles.filter((f) => !f.staged);
    return {
      stagedFiles: buildFileTree(staged),
      stagedCount: staged.length,
      unstagedFiles: buildFileTree(unstaged),
      unstagedCount: unstaged.length,
    };
  }, [allFiles]);

  const handleFileClick = (filePath: string) => {
    const file = allFiles.find((f) => f.path === filePath);
    if (file) {
      setSelectedFile(file);
    }
  };

  const handleRefresh = () => {
    refetch();
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
            {diffStats && (
              <p className="text-muted-foreground text-xs">
                <span className="text-success">+{diffStats.totalInsertions}</span>{" "}
                <span className="text-destructive">-{diffStats.totalDeletions}</span>
                {" · "}
                {diffStats.files.length} files
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isLoading}>
            <RefreshCw className={isLoading ? "animate-spin" : ""} />
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
            <EmptyDescription>{error.message}</EmptyDescription>
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
            {/* File Tree (left side) */}
            <ScrollArea className="border-border w-56 shrink-0 border-r">
              <DiffFileTree
                stagedFiles={stagedFiles}
                unstagedFiles={unstagedFiles}
                stagedCount={stagedCount}
                unstagedCount={unstagedCount}
                onFileClick={handleFileClick}
                selectedPath={selectedFile?.path}
              />
            </ScrollArea>

            {/* Single File Diff (right side) */}
            <div className="min-w-0 flex-1">
              {selectedFile ? (
                <SingleFileDiff repoPath={worktree.path} file={selectedFile} />
              ) : (
                <Empty className="h-full">
                  <EmptyMedia variant="icon">
                    <FileDiffIcon />
                  </EmptyMedia>
                  <EmptyTitle>Select a file</EmptyTitle>
                  <EmptyDescription>Click a file from the tree to view its diff</EmptyDescription>
                </Empty>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
