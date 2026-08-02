import { useNavigate, useParams } from "@tanstack/react-router";
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

import { useProjectSessions } from "@/features/projects/use-project-sessions";

/**
 * One project and the sessions under it, as a sidebar group. Fetching lives in
 * `useProjectSessions`; how a row looks and what a click does are this
 * component's own business.
 */
export function ProjectSessionsGroup({ project }: { project: Project }) {
  const navigate = useNavigate();
  // strict: false — the sidebar renders on every route, and most have no sessionId.
  const { sessionId: activeSessionId } = useParams({ strict: false });
  const sessions = useProjectSessions(project.id);

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
          {sessions.map((session) => (
            <SidebarMenuItem key={session.sessionId}>
              <SidebarMenuButton
                isActive={session.sessionId === activeSessionId}
                // The whole ref rides along so the route can resume directly.
                onClick={() =>
                  navigate({
                    to: "/session/$sessionId",
                    params: { sessionId: session.sessionId },
                    search: { projectId: session.projectId, harness: session.harnessAgentId },
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
