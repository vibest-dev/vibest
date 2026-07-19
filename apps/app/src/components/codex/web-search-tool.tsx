import type { WebSearchUIToolInvocation } from "@vibest/harness/codex";
import { SearchIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexWebSearchTool({ invocation }: { invocation: WebSearchUIToolInvocation }) {
  return (
    <CodexToolCard
      icon={SearchIcon}
      title="Web search"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
