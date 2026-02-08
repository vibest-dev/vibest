import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { FileDiff as FileDiffIcon, TerminalSquare } from "lucide-react";

import type { DiffFileInfo, Worktree } from "../../types";
import type { PaneLeaf as PaneLeafModel } from "./split-state";

import { TerminalPanel } from "../terminal";
import { SingleFileDiff } from "../worktrees/single-file-diff";

interface PaneLeafProps {
  leaf: PaneLeafModel | null;
  selectedWorktree: Worktree | null;
}

function isDiffFileInfo(value: unknown): value is DiffFileInfo {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DiffFileInfo>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.staged === "boolean" &&
    typeof candidate.insertions === "number" &&
    typeof candidate.deletions === "number"
  );
}

export function PaneLeaf({ leaf, selectedWorktree }: PaneLeafProps) {
  if (!selectedWorktree) {
    return (
      <Empty className="h-full">
        <EmptyTitle>No worktree selected</EmptyTitle>
        <EmptyDescription>Select a task to start working.</EmptyDescription>
      </Empty>
    );
  }

  if (!leaf) {
    return (
      <Empty className="h-full">
        <EmptyTitle>No tab selected</EmptyTitle>
        <EmptyDescription>Open a tab in this split.</EmptyDescription>
      </Empty>
    );
  }

  if (leaf.kind === "terminal") {
    return (
      <div className="relative h-full">
        <TerminalPanel
          worktreeId={selectedWorktree.id}
          worktreePath={selectedWorktree.path}
          worktreeExists={selectedWorktree.exists}
          isVisible
        />
      </div>
    );
  }

  if (leaf.kind === "diff") {
    if (!isDiffFileInfo(leaf.state)) {
      return (
        <Empty className="h-full">
          <EmptyMedia variant="icon">
            <FileDiffIcon />
          </EmptyMedia>
          <EmptyTitle>Select a file</EmptyTitle>
          <EmptyDescription>
            Pick a file from the secondary sidebar to inspect diff.
          </EmptyDescription>
        </Empty>
      );
    }

    return <SingleFileDiff repoPath={selectedWorktree.path} file={leaf.state} />;
  }

  return (
    <Empty className="h-full">
      <EmptyMedia variant="icon">
        <TerminalSquare />
      </EmptyMedia>
      <EmptyTitle>Unsupported tab type</EmptyTitle>
      <EmptyDescription>Leaf kind &quot;{leaf.kind}&quot; is not yet implemented.</EmptyDescription>
    </Empty>
  );
}
