import { useHarnessAgent } from "@/features/chat/harness/use-harness";

import { useChatSession } from "./chat-session-context";
import { HarnessIcon } from "./harness-icon";

// Session-config slot: which agent this session runs on. Deliberately static,
// not a disabled dropdown — the harness is part of the SessionRef and can never
// change, and a disabled control would suggest it might under some other
// condition.
//
// That fixedness is also why this is the icon alone: a value that cannot change
// is reference information, and the toolbar's width belongs to the controls
// next to it. The name stays reachable through the tooltip and the accessible
// label.
export function ChatHarnessIcon() {
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
