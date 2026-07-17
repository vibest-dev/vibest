import { createFileRoute } from "@tanstack/react-router";

import { Chat } from "@/components/chat";

export const Route = createFileRoute("/session/$sessionId")({
  component: Component,
});

function Component() {
  const { sessionId } = Route.useParams();

  // The shell (sidebar + card panel + header) lives in the root route; this
  // route is just the chat filling the card.
  return <Chat className="mx-auto w-full max-w-4xl min-w-80" sessionId={sessionId} />;
}
