import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import { useCallback } from "react";

/**
 * The one place that says how `project.list` is held. Its only writer is the
 * import dialog's create mutation, which invalidates on success, so nothing can
 * change it behind our back.
 */
function useProjectListQuery<TData>(
  select: (projects: ReadonlyArray<Project>) => TData,
): UseQueryResult<TData> {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  return useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
    select,
  });
}

// Oldest-first, so importing a project appends to the bottom of the sidebar.
// Module scope: an inline closure would re-run `select` every render.
const selectOrdered = (projects: ReadonlyArray<Project>): ReadonlyArray<Project> =>
  Array.from(projects).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * Every imported project, oldest-first. Returns the query, not just the data:
 * empty is "no projects yet" (the import flow), which is not `isError`.
 */
export function useProjects(): UseQueryResult<ReadonlyArray<Project>> {
  return useProjectListQuery(selectOrdered);
}

/**
 * One project by id, or undefined when the list hasn't landed or no longer
 * knows that id — a URL carrying a since-removed projectId reads as nothing
 * selected. `select` closes over `projectId`, so it must be memoised.
 */
export function useProject(projectId: string | null | undefined): Project | undefined {
  const { data } = useProjectListQuery(
    useCallback(
      (projects: ReadonlyArray<Project>) => projects.find((project) => project.id === projectId),
      [projectId],
    ),
  );
  return data;
}
