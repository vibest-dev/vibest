import { createFileRoute } from "@tanstack/react-router";

import { Chat } from "@/components/chat";

export const Route = createFileRoute("/session/$sessionId")({
  component: Component,
});

function Component() {
  const { sessionId } = Route.useParams();

  return (
    <div className="flex h-full flex-col">
      <Chat className="mx-auto w-full max-w-4xl min-w-80" sessionId={sessionId} />
    </div>
  );
}
