import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import { useCallback } from "react";

/** Resolve a session's project to its workspace path from the panel's SessionRef. */
export function useSessionWorkspace(
  projectId: string | undefined,
): UseQueryResult<Project | undefined> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
    // The select closes over projectId, so memoise it to preserve query result stability.
    select: useCallback(
      (projects: ReadonlyArray<Project>) =>
        projectId === undefined ? undefined : projects.find((project) => project.id === projectId),
      [projectId],
    ),
  });
}
