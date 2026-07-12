import { useNavigate } from "@tanstack/react-router";
import { Button } from "@vibest/ui/components/button";

import { Chat } from "@/components/chat";
import { orpcClient } from "@/lib/orpc";

export const Route = createFileRoute({
  component: Component,
});

function Component() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();

  const handleNewSession = async () => {
    try {
      // Create new session and navigate
      const { sessionId: newSessionId } = await orpcClient.claudeCode.session.create();
      navigate({ to: "/chat/$sessionId", params: { sessionId: newSessionId } });
    } catch (error) {
      console.error("Failed to start a new session", error);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="bg-background flex items-center justify-between border-b p-2">
        <Button size="sm" className="ml-auto" variant="outline" onClick={handleNewSession}>
          New Session
        </Button>
      </div>
      <Chat className="mx-auto w-full max-w-4xl min-w-80" sessionId={sessionId} />
    </div>
  );
}
