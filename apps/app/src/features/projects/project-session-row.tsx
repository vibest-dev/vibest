import { useNavigate } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";
import { SidebarMenuButton, SidebarMenuItem } from "@vibest/ui/components/sidebar";

import { SessionActionsMenu } from "@/features/projects/session-actions-menu";

/** One session row: open-session navigation plus composed session actions. */
export function ProjectSessionRow({
  active,
  isActive,
  session,
}: {
  readonly active: boolean;
  readonly isActive: () => boolean;
  readonly session: SessionSummary;
}) {
  const navigate = useNavigate();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() =>
          navigate({
            to: "/session/$sessionId",
            params: { sessionId: session.sessionId },
            search: { projectId: session.projectId, harness: session.harnessAgentId },
          })
        }
      >
        <span className="truncate">{session.title ?? "New chat"}</span>
        {/* Busy elsewhere too: status is server-derived, so a turn any client
            is running shows here. requires_action keeps the turn open. */}
        {(session.status?.phase === "running" || session.status?.phase === "requires_action") && (
          <span
            className="ms-auto size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
            title="A turn is running in this session"
          />
        )}
      </SidebarMenuButton>
      <SessionActionsMenu isActive={isActive} session={session} />
    </SidebarMenuItem>
  );
}
