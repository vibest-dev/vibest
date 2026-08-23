import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

export function useWorkspaceTree(cwd: string | undefined) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.fs.readTree.queryOptions({
      input: cwd === undefined ? skipToken : { cwd },
    }),
    refetchOnWindowFocus: "always",
    staleTime: Infinity,
  });
}

export type WorkspaceTreeQuery = ReturnType<typeof useWorkspaceTree>;
