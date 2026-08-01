import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import {
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@vibest/ui/components/sidebar";
import { SquarePen } from "lucide-react";

/**
 * One project and the sessions under it, newest first. Titles come from the
 * harness's own session index, which fills them in after the fact (claude
 * summarizes a session once it has something to summarize), so a just-created
 * session shows the "New chat" fallback until a later refetch picks its title up.
 */
export function ProjectSessionsGroup({ project }: { project: Project }) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const navigate = useNavigate();
  // strict: false — the sidebar renders on every route, and most have no sessionId.
  const { sessionId: activeSessionId } = useParams({ strict: false });

  const sessions = useQuery({
    ...orpcQueryUtils.session.list.queryOptions({ input: { projectId: project.id } }),
    staleTime: 30_000,
    select: (list) => Array.from(list).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });

  return (
    <section className="relative min-w-0" aria-labelledby={`project-${project.id}`}>
      {/* pe-8 keeps a long name from running under the absolutely positioned action. */}
      <SidebarGroupLabel
        className="text-sidebar-accent-foreground h-7 min-w-0 pe-8 text-sm"
        id={`project-${project.id}`}
        title={project.path}
      >
        <span className="truncate">{project.name}</span>
      </SidebarGroupLabel>
      <SidebarGroupAction
        className="top-1 right-1"
        onClick={() => navigate({ to: "/draft", search: { projectId: project.id } })}
        title={`New chat in ${project.name}`}
      >
        <SquarePen />
        {/* Names the button per project: element content wins over `title` in the
            accessible-name computation, so a bare "New chat" would make every
            project's action announce identically. */}
        <span className="sr-only">New chat in {project.name}</span>
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {(sessions.data ?? []).map((session) => (
            <SidebarMenuItem key={session.sessionId}>
              <SidebarMenuButton
                isActive={session.sessionId === activeSessionId}
                onClick={() =>
                  navigate({
                    to: "/session/$sessionId",
                    params: { sessionId: session.sessionId },
                  })
                }
              >
                <span className="truncate">{session.title ?? "New chat"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </section>
  );
}
