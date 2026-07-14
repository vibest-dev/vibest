import { Action, Actions } from "@vibest/ui/ai-elements/actions";
import { Message, MessageContent } from "@vibest/ui/ai-elements/message";
import { Response } from "@vibest/ui/ai-elements/response";
import { isToolUIPart, type UIMessage } from "ai";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { ToolBatch } from "./tool-batch";
import { ToolPart } from "./tool-part";
import { useToolBatches } from "./use-tool-batches";

type Part = UIMessage["parts"][number];

// Renders an assistant turn's parts: tool/reasoning runs as collapsible
// batches, standalone tools (Task) as full cards, text as markdown. The copy
// action only appears on the last text once streaming has settled.
export function AssistantMessage({
  message,
  parts,
  isStreaming,
  showActions = true,
}: {
  message: UIMessage;
  parts: readonly Part[];
  isStreaming: boolean;
  showActions?: boolean;
}) {
  const items = useToolBatches(parts);
  const lastTextIndex = parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  return (
    <>
      {items.map((item) => {
        if (item.kind === "tool-batch") {
          return (
            <ToolBatch
              key={`batch-${item.parts[0]?.index ?? 0}`}
              message={message}
              parts={item.parts}
              shouldShimmer={isStreaming && item.isTrailing}
            />
          );
        }
        const { part, index } = item;
        if (isToolUIPart(part)) {
          return <ToolPart key={part.toolCallId} message={message} part={part} />;
        }
        if (part.type === "text") {
          const canShowActions =
            showActions && !isStreaming && index === lastTextIndex && !!part.text.trim();
          return (
            <Message key={index} from="assistant">
              <MessageContent>
                <Response>{part.text}</Response>
                {canShowActions && <CopyMarkdownButton text={part.text} />}
              </MessageContent>
            </Message>
          );
        }
        return null;
      })}
    </>
  );
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Actions>
      <Action
        tooltip={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
      </Action>
    </Actions>
  );
}
