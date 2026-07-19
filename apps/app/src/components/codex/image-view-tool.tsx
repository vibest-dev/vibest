import type { ImageViewUIToolInvocation } from "@vibest/harness/codex";
import { ImageIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexImageViewTool({ invocation }: { invocation: ImageViewUIToolInvocation }) {
  return (
    <CodexToolCard
      icon={ImageIcon}
      title="Image view"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
