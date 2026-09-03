import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

export function useGitBranch(cwd: string | undefined) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.git.branch.queryOptions({
      input: cwd === undefined ? skipToken : { cwd },
    }),
    refetchOnWindowFocus: "always",
    staleTime: Infinity,
  });
}

export type GitBranchQuery = ReturnType<typeof useGitBranch>;
