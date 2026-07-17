import { createFileRoute } from "@tanstack/react-router";

import { Chat } from "@/components/chat";

export const Route = createFileRoute("/session/$sessionId")({
  // The URL carries only the sessionId; the full SessionRef (projectId +
  // harnessAgentId) is reverse-looked-up server-side on load, so a bookmarked
  // or reloaded URL rehydrates the ref.
  loader: ({ context, params }) =>
    context.orpcQueryUtils.session.resolveRef.call({ sessionId: params.sessionId }),
  component: Component,
});

function Component() {
  const sessionRef = Route.useLoaderData();

  // The shell lives in the root route; this is just the chat filling the card.
  return <Chat className="mx-auto w-full max-w-4xl min-w-80" sessionRef={sessionRef} />;
}
