import { useGitWatcher } from "../../hooks/use-git-watcher";
import { useWorktreeDiffStats } from "../../hooks/use-worktree-diff-stats";

interface WorktreeDiffStatsProps {
  path: string;
}

/**
 * Displays git diff stats (insertions/deletions) for a worktree.
 * Shows nothing when the worktree is clean.
 * Hidden on hover (to make room for archive button).
 * Subscribes to git changes to automatically update.
 */
export function WorktreeDiffStats({ path }: WorktreeDiffStatsProps) {
  // Subscribe to git changes for automatic updates
  useGitWatcher(path);

  const stats = useWorktreeDiffStats(path);

  // Don't render anything if no changes
  if (!stats) {
    return null;
  }

  return (
    <div className="mr-1 flex shrink-0 items-center gap-0.5 text-[10px] font-medium tabular-nums transition-opacity duration-150 group-hover/worktree:opacity-0">
      {stats.insertions > 0 && <span className="text-success">+{stats.insertions}</span>}
      {stats.deletions > 0 && <span className="text-destructive">-{stats.deletions}</span>}
    </div>
  );
}
