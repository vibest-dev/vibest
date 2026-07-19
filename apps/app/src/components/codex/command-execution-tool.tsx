import type { CommandExecutionUIToolInvocation } from "@vibest/harness/codex";
import { SquareTerminalIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexCommandExecutionTool({
  invocation,
}: {
  invocation: CommandExecutionUIToolInvocation;
}) {
  return (
    <CodexToolCard
      icon={SquareTerminalIcon}
      title="Command"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
