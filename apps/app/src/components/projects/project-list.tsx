import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { ProjectSessionsGroup } from "@/components/projects/project-sessions-group";

/**
 * Every imported project, each rendering its own session list. Projects are
 * ordered oldest-first so importing one appends to the bottom instead of
 * pushing the whole tree down.
 */
export function ProjectList() {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });

  // The only writer is the import dialog's create mutation, which invalidates on success.
  const projects = useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
    select: (list) => Array.from(list).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });

  return (
    <>
      {(projects.data ?? []).map((project) => (
        <ProjectSessionsGroup key={project.id} project={project} />
      ))}
    </>
  );
}
