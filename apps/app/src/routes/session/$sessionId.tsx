import { createFileRoute } from "@tanstack/react-router";

import { Chat } from "@/components/chat";

export const Route = createFileRoute("/session/$sessionId")({
  // The URL carries only the sessionId; the full SessionRef (projectId +
  // harnessAgentId) is reverse-looked-up server-side on load, so a bookmarked
  // or reloaded URL rehydrates the ref.
  loader: async ({ context, params }) => {
    const ref = await context.orpcQueryUtils.session.resolveRef.call({
      sessionId: params.sessionId,
    });
    // Cold load (bookmark, reload, server restart): bring the runtime and the
    // native session back up. Resume is idempotent for a live session. A
    // failure still renders the page; the full SESSION_NOT_ACTIVE→resume
    // recovery loop is ticket 12.
    await context.orpcQueryUtils.session.resume.call({ ref }).catch((error: unknown) => {
      console.error("Failed to resume session", error);
    });
    return ref;
  },
  component: Component,
});

function Component() {
  const sessionRef = Route.useLoaderData();

  // The shell lives in the root route; this is just the chat filling the card.
  return <Chat className="mx-auto w-full max-w-4xl min-w-80" sessionRef={sessionRef} />;
}
