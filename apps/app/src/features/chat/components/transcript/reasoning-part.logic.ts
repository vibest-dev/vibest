import type { ReasoningUIPart } from "ai";

export function shouldRenderReasoningPart(
  part: ReasoningUIPart,
  isMessageStreaming = false,
): boolean {
  const text = part.text ?? "";
  const isReasoningStreaming = part.state === "streaming";
  const isStreaming = isReasoningStreaming || (isMessageStreaming && part.state !== "done");
  return isStreaming || !!text.trim();
}
