import { createFileRoute, redirect } from "@tanstack/react-router";
import { toast } from "sonner";

import { Chat } from "@/components/chat";

export const Route = createFileRoute("/session/$sessionId")({
  // The URL carries only the sessionId; the full SessionRef (projectId +
  // harnessAgentId) is reverse-looked-up server-side on load, so a bookmarked
  // or reloaded URL rehydrates the ref.
  loader: async ({ context, params }) => {
    // An unresolvable sessionId (pruned storage, hand-edited URL) would
    // otherwise throw straight out of the loader into the router's raw error
    // UI — no defaultErrorComponent is configured. Send the user somewhere
    // usable instead, and say why.
    const ref = await context.orpcQueryUtils.session.resolveRef
      .call({ sessionId: params.sessionId })
      .catch((error: unknown) => {
        console.error("Failed to resolve session", error);
        toast.error(`Session ${params.sessionId} could not be found.`);
        throw redirect({ to: "/draft" });
      });
    // Cold load (bookmark, reload, server restart): bring the runtime and the
    // native session back up. Resume is idempotent for a live session. A
    // failure still renders the page; the full SESSION_NOT_ACTIVE→resume
    // recovery loop is ticket 12.
    // A session the harness no longer knows (its native history was cleaned up)
    // fails here — surface it instead of leaving a silently dead chat. The page
    // still renders, so keep the console trail for diagnosis after the toast
    // auto-dismisses.
    await context.orpcQueryUtils.session.resume.call({ ref }).catch((error: unknown) => {
      console.error("Failed to resume session", error);
      toast.error(
        `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return ref;
  },
  component: Component,
});

function Component() {
  const sessionRef = Route.useLoaderData();

  // The shell lives in the root route; this is just the chat filling the card.
  // Full width on purpose: the transcript's scroll container must span the
  // panel so its scrollbar sits at the panel edge — the reading column is
  // centered inside the scroller, not around it.
  return <Chat sessionRef={sessionRef} />;
}
