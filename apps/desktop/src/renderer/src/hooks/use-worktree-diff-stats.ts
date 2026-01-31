import { skipToken, useQuery } from "@tanstack/react-query";

import { orpc } from "../lib/queries/workspace";

/**
 * Hook to fetch git diff stats (insertions/deletions) for a worktree.
 * Returns null when the worktree is clean (no changes).
 */
export function useWorktreeDiffStats(path: string | undefined) {
  const { data: diffResult, isLoading } = useQuery(
    orpc.git.diff.queryOptions({
      input: path ? { path, staged: false } : skipToken,
    }),
  );

  // Return null if loading, no data, or clean (no changes)
  if (isLoading || !diffResult || diffResult.stats.filesChanged === 0) {
    return null;
  }

  return {
    insertions: diffResult.stats.insertions,
    deletions: diffResult.stats.deletions,
  };
}
