import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import { useCallback } from "react";

/**
 * The one place that says how `project.list` is held. Its only writer is the
 * import dialog's create mutation, which invalidates on success, so nothing can
 * change it behind our back and it is held indefinitely. That was previously
 * restated at each call site, where a single omission would have bought that
 * caller its own refetch cycle against the same key.
 *
 * Every hook below narrows inside `select` so a subscriber re-renders only when
 * its own slice changes — importing a project is not a reason to redraw a
 * session's toolbar.
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

// Oldest-first, so importing a project appends to the bottom of the sidebar
// instead of pushing the whole tree down. Module scope, not an inline closure:
// a new function every render would re-run `select` and lose the referential
// stability the subscribers depend on.
const selectOrdered = (projects: ReadonlyArray<Project>): ReadonlyArray<Project> =>
  Array.from(projects).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * Every imported project, oldest-first.
 *
 * Returns the whole query, because its non-success states are meaningful and
 * distinct: `isPending` is the first load, `isError` is a failure worth a retry
 * affordance, and an empty array is "no projects yet" — which is the import
 * flow, not an error. A caller that renders none of those can read `.data`.
 */
export function useProjects(): UseQueryResult<ReadonlyArray<Project>> {
  return useProjectListQuery(selectOrdered);
}

/**
 * One project by id, or undefined when the list hasn't landed or no longer
 * knows that id. Both read as "nothing selected", which is what a URL carrying
 * a since-removed projectId should mean — a stale selection is never rendered.
 *
 * `select` closes over `projectId`, so it must be memoised (see above).
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
