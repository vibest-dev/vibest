import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import { useCallback } from "react";

/**
 * The directory a project points at, which is what harness catalogs are keyed
 * by. A `SessionRef` carries only a `projectId`, so a live session has to make
 * this hop to ask what its harness can offer.
 *
 * The path is not copied onto the SessionRef to save the hop: it belongs to the
 * project record, and a second copy is a second thing that can go stale when a
 * project is re-pointed. `project.list` is already held by the sidebar under
 * the same key, so in practice this reads from cache rather than fetching.
 *
 * Narrowing happens in `select`, not in the caller: subscribers then re-render
 * when *this project's path* changes, rather than every time the project list
 * gets a new array — importing an unrelated project is not a reason to redraw a
 * session's toolbar. `select` is memoised on `projectId` because an inline
 * closure would be a new function every render, which defeats it.
 */
export function useProjectPath(projectId: string): string | undefined {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const { data } = useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
    select: useCallback(
      (projects: ReadonlyArray<Project>) =>
        projects.find((project) => project.id === projectId)?.path,
      [projectId],
    ),
  });
  return data;
}
