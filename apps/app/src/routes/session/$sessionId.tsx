import { createFileRoute, redirect } from "@tanstack/react-router";
import { HARNESS_AGENT_IDS, type HarnessAgentId, type SessionRef } from "@vibest/contract";
import { toast } from "sonner";

import { Chat } from "@/features/chat/chat";
import { useProject } from "@/features/projects/use-projects";

/**
 * The rest of the SessionRef, carried alongside the path's `sessionId`, so the
 * loader can resume directly instead of buying the other two with a
 * `resolveRef` round trip first.
 *
 * A hint, never the authority — a URL without them, or with stale ones, still
 * works by falling back to the lookup. Both or neither: half a ref can't skip
 * it.
 */
type SessionSearch = {
  readonly projectId?: string;
  readonly harness?: HarnessAgentId;
};

const asHarnessAgentId = (value: unknown): HarnessAgentId | undefined =>
  HARNESS_AGENT_IDS.find((id) => id === value);

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const Route = createFileRoute("/session/$sessionId")({
  validateSearch: (search: Record<string, unknown>): SessionSearch => {
    const projectId = asText(search.projectId);
    const harness = asHarnessAgentId(search.harness);
    return projectId !== undefined && harness !== undefined ? { projectId, harness } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const { session } = context.orpcQueryUtils;

    // Fast path: the link handed us a whole ref, so resume can go first. We
    // return what the server answers with, not what the URL claimed.
    if (deps.projectId !== undefined && deps.harness !== undefined) {
      const hinted: SessionRef = {
        projectId: deps.projectId,
        harnessAgentId: deps.harness,
        sessionId: params.sessionId,
      };
      const resumed = await session.resume.call({ ref: hinted }).catch((error: unknown) => {
        // A bad hint and an unresumable session both fall through to the
        // lookup; only this line tells them apart afterwards.
        console.warn("Resume from URL ref failed, falling back to lookup", error);
        return undefined;
      });
      if (resumed) return resumed;
    }

    // An unresolvable sessionId (pruned storage, hand-edited URL) would
    // otherwise throw straight out of the loader into the router's raw error
    // UI — no defaultErrorComponent is configured. Send the user somewhere
    // usable instead, and say why.
    const ref = await session.resolveRef
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
    await session.resume.call({ ref }).catch((error: unknown) => {
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
  // The route is where the two features meet: chat needs a working directory,
  // projects is what turns a projectId into one. Reads the sidebar's cache.
  const cwd = useProject(sessionRef.projectId)?.path;

  // The shell lives in the root route; this is just the chat filling the card.
  // Full width on purpose: the transcript's scroll container must span the
  // panel so its scrollbar sits at the panel edge — the reading column is
  // centered inside the scroller, not around it.
  return <Chat cwd={cwd} sessionRef={sessionRef} />;
}
