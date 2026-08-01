import { useHarnessAgent } from "@/features/chat/harness/use-harness";

import { useChatSession } from "./chat-session-context";

// Which agent this session runs on. Deliberately a static badge, not a disabled
// dropdown: the harness is part of the SessionRef and can never change, and a
// disabled control would suggest it might under some other condition.
export function HarnessBadge() {
  const { harnessAgentId } = useChatSession();
  const harnessAgent = useHarnessAgent(harnessAgentId);
  return (
    <span className="text-muted-foreground inline-flex min-h-8 items-center px-1 text-sm">
      {harnessAgent?.name ?? harnessAgentId}
    </span>
  );
}
