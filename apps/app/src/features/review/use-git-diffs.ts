import { skipToken, useQueries } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { GitReviewFile, GitReviewMode } from "@vibest/contract/git";

export function useGitDiffs(
  cwd: string | undefined,
  files: ReadonlyArray<GitReviewFile>,
  mode: GitReviewMode,
  other: string | undefined,
) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQueries({
    queries: files.map((file) => ({
      ...orpcQueryUtils.git.diff.queryOptions({
        input:
          cwd === undefined
            ? skipToken
            : {
                cwd,
                path: file.path,
                mode,
                ...(mode === "branch" && other !== undefined ? { other } : {}),
              },
      }),
      refetchOnWindowFocus: "always" as const,
      staleTime: Infinity,
    })),
  });
}

export type GitDiffsQuery = ReturnType<typeof useGitDiffs>;
