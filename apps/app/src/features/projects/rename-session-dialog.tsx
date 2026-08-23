import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { MAX_SESSION_TITLE_CHARS, type SessionSummary } from "@vibest/contract";
import { Button } from "@vibest/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@vibest/ui/components/dialog";
import { Input } from "@vibest/ui/components/input";
import { Label } from "@vibest/ui/components/label";
import { useState } from "react";
import { toast } from "sonner";

import { reconcileSessionRenameSuccess } from "@/features/projects/session-list-cache";

/**
 * Give a session a title of your own. Mount only while open — the draft title
 * resets by unmounting on close, the same way the import dialog resets its
 * browsing state.
 *
 * The server publishes `session.renamed` only after the title is durable, and
 * the app's one global event consumer folds that event into every active or
 * archived session list. Success also performs a guarded local reconciliation
 * for the initiating tab: it repairs a non-replay subscription gap without
 * overwriting a different title that a newer event has already applied.
 */
export function RenameSessionDialog({
  session,
  onClose,
}: {
  readonly session: SessionSummary;
  onClose: () => void;
}) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(session.title ?? "");
  // The wire schema takes a trimmed, non-empty title; trimming here makes
  // " foo " a rename rather than a validation error the user must decode.
  const title = draft.trim();

  const rename = useMutation({
    mutationFn: (variables: {
      readonly title: string;
      readonly previousTitle: string | undefined;
    }) =>
      orpcQueryUtils.session.rename.call({
        ref: {
          projectId: session.projectId,
          harnessAgentId: session.harnessAgentId,
          sessionId: session.sessionId,
        },
        title: variables.title,
      }),
    onSuccess: (_result, variables) => {
      const ref = {
        projectId: session.projectId,
        harnessAgentId: session.harnessAgentId,
        sessionId: session.sessionId,
      };
      reconcileSessionRenameSuccess(
        queryClient,
        (projectId, archived) =>
          orpcQueryUtils.session.list.queryOptions({ input: { projectId, archived } }).queryKey,
        ref,
        variables.previousTitle,
        variables.title,
      );
      onClose();
    },
    onError: (error) => toast.error(`Failed to rename session: ${error.message}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !rename.isPending && onClose()}>
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate({ title, previousTitle: session.title });
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              The title is yours — a later prompt never overwrites it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-start gap-2 px-6 pb-4">
            <Label htmlFor="session-title">Title</Label>
            <Input
              autoFocus
              disabled={rename.isPending}
              id="session-title"
              maxLength={MAX_SESSION_TITLE_CHARS}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              placeholder="New chat"
              value={draft}
            />
          </div>
          <DialogFooter>
            <DialogClose
              render={<Button disabled={rename.isPending} type="button" variant="outline" />}
            >
              Cancel
            </DialogClose>
            <Button
              disabled={rename.isPending || title === "" || title === session.title}
              type="submit"
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
