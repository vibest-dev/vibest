import type { FileChangeUIToolInvocation } from "@vibest/harness/codex";
import { FilePenLineIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexFileChangeTool({ invocation }: { invocation: FileChangeUIToolInvocation }) {
  return (
    <CodexToolCard
      icon={FilePenLineIcon}
      title="File change"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
