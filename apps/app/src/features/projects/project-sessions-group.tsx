import { useNavigate } from "@tanstack/react-router";
import type { Project, SessionRef, SessionSummary } from "@vibest/contract";
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
import { Folder, FolderOpen, SquarePen } from "lucide-react";

import { ProjectSessionRow } from "@/features/projects/project-session-row";
import { useProjectSessions } from "@/features/projects/use-project-sessions";

const EMPTY_SESSIONS: ReadonlyArray<SessionSummary> = [];

/**
 * One project and the sessions under it, as a collapsible sidebar group. The
 * label is its own collapse trigger; a Folder icon swaps to FolderOpen when the
 * panel is open (two icon entities, not a rotation). This component owns only
 * grouping and fetching; each row composes its own navigation and actions.
 */
export function ProjectSessionsGroup({
  isSessionActive,
  project,
}: {
  readonly isSessionActive: (ref: SessionRef) => boolean;
  readonly project: Project;
}) {
  const navigate = useNavigate();
  const sessions = useProjectSessions(project.id);
  const rows = sessions.data ?? EMPTY_SESSIONS;

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
              {rows.map((session) => (
                <ProjectSessionRow
                  key={session.sessionId}
                  active={isSessionActive(session)}
                  isActive={() => isSessionActive(session)}
                  session={session}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
