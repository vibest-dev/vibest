import { Reasoning, ReasoningContent, ReasoningTrigger } from "@vibest/ui/ai-elements/reasoning";
import type { ReasoningUIPart } from "ai";

import { shouldRenderReasoningPart } from "./reasoning-part.logic";

/** One assistant reasoning block. Empty settled blocks are dropped. */
export function ReasoningPart({
  part,
  isMessageStreaming = false,
}: {
  part: ReasoningUIPart;
  /** True while the parent assistant turn is still streaming. */
  isMessageStreaming?: boolean;
}) {
  const text = part.text ?? "";
  const isReasoningStreaming = part.state === "streaming";
  const isStreaming = isReasoningStreaming || (isMessageStreaming && part.state !== "done");
  if (!shouldRenderReasoningPart(part, isMessageStreaming)) return null;

  return (
    <Reasoning className="mb-0 py-1" isStreaming={isReasoningStreaming} defaultOpen={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent className="mt-2 [&_.font-semibold]:font-normal [&_p]:mb-2 [&_p]:leading-5 [&_p:last-child]:mb-0">
        {text}
      </ReasoningContent>
    </Reasoning>
  );
}
