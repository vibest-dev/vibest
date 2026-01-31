import { skipToken, useMutation, useQuery } from "@tanstack/react-query";

import {
  gitFetchMutationCallbacks,
  gitPullMutationCallbacks,
  orpc,
} from "../lib/queries/workspace";
import { queryClient } from "../lib/query-client";

/**
 * Hook to fetch git status for a specific worktree path.
 * Uses TanStack Query via oRPC for caching and automatic refetching.
 */
export function useGitStatus(path: string | undefined) {
  const { data: status, isLoading } = useQuery(
    orpc.git.status.queryOptions({
      input: path ? { path } : skipToken,
    }),
  );

  const fetchMutation = useMutation({
    ...orpc.git.fetch.mutationOptions(),
    ...gitFetchMutationCallbacks(),
  });

  const pullMutation = useMutation({
    ...orpc.git.pull.mutationOptions(),
    ...gitPullMutationCallbacks(),
  });

  return {
    status,
    isLoading,
    refresh: () => {
      if (path) {
        queryClient.invalidateQueries({
          queryKey: orpc.git.status.key({ input: { path } }),
        });
      }
    },
    fetch: () => (path ? fetchMutation.mutateAsync({ path }) : Promise.resolve()),
    pull: () => (path ? pullMutation.mutateAsync({ path }) : Promise.resolve()),
  };
}
