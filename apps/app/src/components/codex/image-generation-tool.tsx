import type { ImageGenerationUIToolInvocation } from "@vibest/harness/codex";
import { ImageIcon } from "lucide-react";

import { CodexToolCard } from "./codex-tool-card";

export function CodexImageGenerationTool({
  invocation,
}: {
  invocation: ImageGenerationUIToolInvocation;
}) {
  return (
    <CodexToolCard
      icon={ImageIcon}
      title="Image generation"
      input={invocation.input}
      output={invocation.state === "output-available" ? invocation.output : undefined}
    />
  );
}
