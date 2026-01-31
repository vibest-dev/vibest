import { useWorktreeDiffStats } from "../../hooks/use-worktree-diff-stats";

interface WorktreeDiffStatsProps {
  path: string;
}

/**
 * Displays git diff stats (insertions/deletions) for a worktree.
 * Shows nothing when the worktree is clean.
 * Hidden on hover (to make room for archive button).
 */
export function WorktreeDiffStats({ path }: WorktreeDiffStatsProps) {
  const stats = useWorktreeDiffStats(path);

  // Don't render anything if no changes
  if (!stats) {
    return null;
  }

  return (
    <div className="absolute right-1 flex shrink-0 items-center gap-0.5 text-[10px] font-medium tabular-nums transition-opacity duration-150 group-hover/worktree:opacity-0">
      <span className="text-success">+{stats.insertions}</span>
      <span className="text-destructive">-{stats.deletions}</span>
    </div>
  );
}
