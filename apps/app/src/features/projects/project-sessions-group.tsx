import { useNavigate, useParams } from "@tanstack/react-router";
import type { Project } from "@vibest/contract";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import {
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@vibest/ui/components/sidebar";
import { Folder, FolderOpen, SquarePen } from "lucide-react";

import { useProjectSessions } from "@/features/projects/use-project-sessions";

/**
 * One project and the sessions under it, as a collapsible sidebar group. The
 * label is its own collapse trigger; a Folder icon swaps to FolderOpen when the
 * panel is open (two icon entities, not a rotation). Fetching lives in
 * `useProjectSessions`; how a row looks and what a click does are this
 * component's own business.
 */
export function ProjectSessionsGroup({ project }: { project: Project }) {
  const navigate = useNavigate();
  // strict: false — the sidebar renders on every route, and most have no sessionId.
  const { sessionId: activeSessionId } = useParams({ strict: false });
  const sessions = useProjectSessions(project.id);

  return (
    <Collapsible defaultOpen>
      <section className="relative min-w-0" aria-labelledby={`project-${project.id}`}>
        {/* pe-8 keeps a long name off the absolutely positioned action; w-full is what
            makes it and `truncate` bite, since the label renders as a shrink-to-fit <button>. */}
        <SidebarGroupLabel
          className="text-sidebar-accent-foreground h-7 w-full min-w-0 pe-8 text-sm"
          id={`project-${project.id}`}
          title={project.path}
          render={
            <CollapsibleTrigger className="group/project hover:bg-sidebar-accent/70 cursor-pointer gap-1.5" />
          }
        >
          {/* Folder closed → FolderOpen when the panel expands. */}
          <Folder className="size-4 shrink-0 group-data-[panel-open]/project:hidden" />
          <FolderOpen className="hidden size-4 shrink-0 group-data-[panel-open]/project:block" />
          <span className="truncate">{project.name}</span>
        </SidebarGroupLabel>
        <SidebarGroupAction
          className="top-1 right-1"
          onClick={() => navigate({ to: "/draft", search: { projectId: project.id } })}
          title={`New chat in ${project.name}`}
        >
          <SquarePen />
          {/* Names the button per project: element content wins over `title` in the accessible-name computation, so a bare "New chat" would make every project's action announce identically. */}
          <span className="sr-only">New chat in {project.name}</span>
        </SidebarGroupAction>
        <CollapsiblePanel>
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
                    {/* Busy elsewhere too: status is server-derived, so a turn any client is running shows here. requires_action keeps the turn open, so it counts as busy. */}
                    {(session.status?.phase === "running" ||
                      session.status?.phase === "requires_action") && (
                      <span
                        className="ms-auto size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                        title="A turn is running in this session"
                      />
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
