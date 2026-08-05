import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import type { Project, SessionSummary } from "@vibest/contract";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import {
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@vibest/ui/components/sidebar";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  SquarePen,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useProjectSessions } from "@/features/projects/use-project-sessions";

const EMPTY_SESSIONS: ReadonlyArray<SessionSummary> = [];

function SessionMenuItem({
  activeSessionId,
  archivePending,
  onArchiveChange,
  onOpen,
  session,
}: {
  readonly activeSessionId: string | undefined;
  readonly archivePending: boolean;
  readonly onArchiveChange: (session: SessionSummary, archived: boolean) => void;
  readonly onOpen: (session: SessionSummary) => void;
  readonly session: SessionSummary;
}) {
  const title = session.title ?? "New chat";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={session.sessionId === activeSessionId}
        onClick={() => onOpen(session)}
      >
        <span className="truncate">{title}</span>
        {/* Busy elsewhere too: status is server-derived, so a turn any client
            is running shows here. requires_action keeps the turn open. */}
        {(session.status?.phase === "running" || session.status?.phase === "requires_action") && (
          <span
            className="ms-auto size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
            title="A turn is running in this session"
          />
        )}
      </SidebarMenuButton>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Actions for ${title}`}
              disabled={archivePending}
              showOnHover
            />
          }
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="start" side="right">
          <MenuItem
            disabled={archivePending}
            onClick={() => onArchiveChange(session, !session.archived)}
          >
            {session.archived ? <ArchiveRestore /> : <Archive />}
            {session.archived ? "Restore" : "Archive"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

/**
 * One project and the sessions under it, as a collapsible sidebar group. The
 * label is its own collapse trigger; a Folder icon swaps to FolderOpen when the
 * panel is open (two icon entities, not a rotation). Fetching lives in
 * `useProjectSessions`; how a row looks and what a click does are this
 * component's own business.
 */
export function ProjectSessionsGroup({ project }: { project: Project }) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [archivedOpen, setArchivedOpen] = useState(false);
  // strict: false — the sidebar renders on every route, and most have no sessionId.
  const { sessionId: activeSessionId } = useParams({ strict: false });
  const activeSessions = useProjectSessions(project.id);
  const archivedSessions = useProjectSessions(project.id, {
    archived: true,
    enabled: archivedOpen,
  });

  const setArchived = useMutation({
    mutationFn: ({ archived, session }: { archived: boolean; session: SessionSummary }) =>
      orpcQueryUtils.session.archive.call({
        ref: {
          projectId: session.projectId,
          harnessAgentId: session.harnessAgentId,
          sessionId: session.sessionId,
        },
        archived,
      }),
    onSuccess: (_, { session }) => {
      const listKey = (archived: boolean) =>
        orpcQueryUtils.session.list.queryOptions({
          input: { projectId: session.projectId, archived },
        }).queryKey;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey(false) }),
        queryClient.invalidateQueries({ queryKey: listKey(true) }),
      ]);
    },
    onError: (error) => toast.error(`Failed to update session: ${error.message}`),
  });

  const openSession = (session: SessionSummary) =>
    navigate({
      to: "/session/$sessionId",
      params: { sessionId: session.sessionId },
      search: { projectId: session.projectId, harness: session.harnessAgentId },
    });
  const pendingSessionId = setArchived.isPending
    ? setArchived.variables?.session.sessionId
    : undefined;
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
                <SessionMenuItem
                  activeSessionId={activeSessionId}
                  archivePending={pendingSessionId === session.sessionId}
                  key={session.sessionId}
                  onArchiveChange={(target, archived) =>
                    setArchived.mutate({ session: target, archived })
                  }
                  onOpen={openSession}
                  session={session}
                />
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
                      <SessionMenuItem
                        activeSessionId={activeSessionId}
                        archivePending={pendingSessionId === session.sessionId}
                        key={session.sessionId}
                        onArchiveChange={(target, archived) =>
                          setArchived.mutate({ session: target, archived })
                        }
                        onOpen={openSession}
                        session={session}
                      />
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
