import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMatch, useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import { useCallback } from "react";

/** Resolve the active session's project to its workspace path without coupling this feature to projects UI. */
export function useSessionWorkspace(): UseQueryResult<Project | undefined> {
  const projectId = useMatch({
    from: "/session/$sessionId",
    shouldThrow: false,
    select: (match) => match.loaderData?.projectId,
  });
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
    // The select closes over projectId, so memoise it to preserve query result stability.
    select: useCallback(
      (projects: ReadonlyArray<Project>) => projects.find((project) => project.id === projectId),
      [projectId],
    ),
  });
}
