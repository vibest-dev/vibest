import type { CollabAgentToolCallUIToolInvocation } from "@vibest/harness/codex";
import { UsersIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexCollabAgentToolCallTool({
  invocation,
}: {
  invocation: CollabAgentToolCallUIToolInvocation;
}) {
  return (
    <CodexToolCard
      icon={UsersIcon}
      title="Collab agent"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
