import { useHarnessAgent } from "@/features/chat/harness/use-harness";

import { useChatSession } from "./chat-session-context";
import { HarnessIcon } from "./harness-icon";

// Which agent this session runs on. Deliberately a static badge, not a disabled
// dropdown: the harness is part of the SessionRef and can never change, and a
// disabled control would suggest it might under some other condition.
//
// Icon only: the harness never changes for a live session, so the name is
// reference information the toolbar doesn't need to spend width on. The name
// stays reachable through the tooltip and the accessible label.
export function HarnessBadge() {
  const { harnessAgentId } = useChatSession();
  const harnessAgent = useHarnessAgent(harnessAgentId);
  const name = harnessAgent?.name ?? harnessAgentId;
  return (
    <span
      aria-label={name}
      className="text-muted-foreground inline-flex min-h-8 items-center px-1"
      title={name}
    >
      <HarnessIcon className="size-4 shrink-0" harnessAgentId={harnessAgentId} />
    </span>
  );
}
