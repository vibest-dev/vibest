import { useNavigate } from "@tanstack/react-router";
import type { Project, SessionSummary } from "@vibest/contract";
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
} from "@vibest/ui/components/sidebar";
import { ChevronRight, Folder, FolderOpen, SquarePen } from "lucide-react";
import { useState } from "react";

import { ProjectSessionRow } from "@/features/projects/project-session-row";
import { useProjectSessions } from "@/features/projects/use-project-sessions";

const EMPTY_SESSIONS: ReadonlyArray<SessionSummary> = [];

/**
 * One project and the sessions under it, as a collapsible sidebar group. The
 * label is its own collapse trigger; a Folder icon swaps to FolderOpen when the
 * panel is open (two icon entities, not a rotation). This component owns only
 * grouping and fetching; each row composes its own navigation and actions.
 */
export function ProjectSessionsGroup({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeSessions = useProjectSessions(project.id);
  const archivedSessions = useProjectSessions(project.id, {
    archived: true,
    enabled: archivedOpen,
  });

  const activeRows = activeSessions.data ?? EMPTY_SESSIONS;
  const archivedRows = archivedSessions.data ?? EMPTY_SESSIONS;

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
              {activeRows.map((session) => (
                <ProjectSessionRow key={session.sessionId} session={session} />
              ))}
            </SidebarMenu>
            <Collapsible className="mt-1" onOpenChange={setArchivedOpen} open={archivedOpen}>
              <CollapsibleTrigger className="text-sidebar-foreground/70 hover:bg-sidebar-accent/70 group/archived-trigger flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-xs font-medium outline-hidden focus-visible:ring-2">
                <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/archived-trigger:rotate-90" />
                <span>Archived</span>
                {archivedSessions.data !== undefined ? (
                  <span className="ms-auto tabular-nums">{archivedRows.length}</span>
                ) : null}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                {archivedSessions.isPending ? (
                  <p className="text-sidebar-foreground/60 px-2 py-1 text-xs">Loading...</p>
                ) : archivedRows.length === 0 ? (
                  <p className="text-sidebar-foreground/60 px-2 py-1 text-xs">
                    No archived sessions
                  </p>
                ) : (
                  <SidebarMenu className="pt-1">
                    {archivedRows.map((session) => (
                      <ProjectSessionRow key={session.sessionId} session={session} />
                    ))}
                  </SidebarMenu>
                )}
              </CollapsiblePanel>
            </Collapsible>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
