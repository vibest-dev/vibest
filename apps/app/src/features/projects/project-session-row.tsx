import { useNavigate } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";
import { SidebarMenuButton, SidebarMenuItem } from "@vibest/ui/components/sidebar";

import { SessionActionsMenu } from "@/features/projects/session-actions-menu";
import { SessionStatusIndicator } from "@/features/projects/session-status-indicator";

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
        <SessionStatusIndicator phase={session.status?.phase} />
      </SidebarMenuButton>
      <SessionActionsMenu isActive={isActive} session={session} />
    </SidebarMenuItem>
  );
}
