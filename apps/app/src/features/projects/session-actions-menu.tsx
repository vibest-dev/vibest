import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouteContext } from "@tanstack/react-router";
import type { SessionSummary } from "@vibest/contract";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import { SidebarMenuAction } from "@vibest/ui/components/sidebar";
import { Archive, ArchiveRestore, Ellipsis } from "lucide-react";
import { toast } from "sonner";

/** Session mutations live behind one actions-menu capability boundary. */
export function SessionActionsMenu({ session }: { readonly session: SessionSummary }) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // strict: false — the menu also renders on routes without a sessionId.
  const { sessionId: activeSessionId } = useParams({ strict: false });
  const title = session.title ?? "New chat";

  const setArchived = useMutation({
    mutationFn: (archived: boolean) =>
      orpcQueryUtils.session.archive.call({
        ref: {
          projectId: session.projectId,
          harnessAgentId: session.harnessAgentId,
          sessionId: session.sessionId,
        },
        archived,
      }),
    onSuccess: (_, archived) => {
      const listKey = (isArchived: boolean) =>
        orpcQueryUtils.session.list.queryOptions({
          input: { projectId: session.projectId, archived: isArchived },
        }).queryKey;
      const refreshLists = Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey(false) }),
        queryClient.invalidateQueries({ queryKey: listKey(true) }),
      ]);

      if (archived && activeSessionId === session.sessionId) {
        return Promise.all([
          refreshLists,
          navigate({ to: "/draft", search: { projectId: session.projectId } }),
        ]);
      }

      return refreshLists;
    },
    onError: (error) => toast.error(`Failed to update session: ${error.message}`),
  });

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuAction
            aria-label={`Actions for ${title}`}
            disabled={setArchived.isPending}
            showOnHover
          />
        }
      >
        <Ellipsis />
      </MenuTrigger>
      <MenuPopup align="start" side="right">
        <MenuItem
          disabled={setArchived.isPending}
          onClick={() => setArchived.mutate(!session.archived)}
        >
          {session.archived ? <ArchiveRestore /> : <Archive />}
          {session.archived ? "Restore" : "Archive"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
