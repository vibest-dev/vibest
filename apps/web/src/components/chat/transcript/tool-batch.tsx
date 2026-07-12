import { Shimmer } from "@vibest/ui/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { isToolUIPart } from "ai";
import { WrenchIcon } from "lucide-react";

import type { ClaudeCodeUIMessage } from "@/types";

import { computeBatchTriggerLabel } from "./compute-batch-trigger";
import { ToolPart } from "./tool-part";

type Part = ClaudeCodeUIMessage["parts"][number];

// One collapsible accordion for a run of consecutive tool calls. The trigger
// summarizes the work; it pulses while the tail of the turn is still
// streaming. Reasoning parts stay in the batch's data flow but never render —
// the pulsing trigger is the thinking signal.
export function ToolBatch({
  message,
  parts,
  shouldShimmer,
}: {
  message: ClaudeCodeUIMessage;
  parts: readonly Part[];
  shouldShimmer: boolean;
}) {
  const label = computeBatchTriggerLabel(parts) ?? (shouldShimmer ? "Thinking" : "Thought process");
  return (
    <Tool>
      <ToolHeader icon={WrenchIcon}>
        {shouldShimmer ? (
          <Shimmer as="span" duration={2}>
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </ToolHeader>
      <ToolContent>
        {parts.map((part) =>
          isToolUIPart(part) && part.type !== "dynamic-tool" ? (
            <ToolPart key={part.toolCallId} message={message} part={part} />
          ) : null,
        )}
      </ToolContent>
    </Tool>
  );
}
