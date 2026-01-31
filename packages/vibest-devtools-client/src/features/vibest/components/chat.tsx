"use client";

import type { InspectMetadata } from "@vibest/code-inspector-web";

import { useChat } from "@ai-sdk/react";
import { eventIteratorToStream } from "@orpc/client";
import { inspectorStoreSync } from "@vibest/code-inspector-web";
import { getFilenameFromPath } from "@vibest/code-inspector-web/util";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@vibest/ui/ai-elements/conversation";
import { Loader } from "@vibest/ui/ai-elements/loader";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Badge } from "@vibest/ui/components/badge";
import { Button } from "@vibest/ui/components/button";
import {
  createListCollection,
  Select,
  SelectContent,
  SelectControl,
  SelectItem,
  SelectTrigger,
  SelectValueText,
} from "@vibest/ui/components/select";
import { cn } from "@vibest/ui/lib/utils";
import { useSelector } from "@xstate/store/react";
import { MousePointerClickIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { ClaudeCodeUIMessage } from "@/types";

import { ClaudeCodeMessageParts } from "@/components/message-parts";
import { useToolbarContext } from "@/context/toolbar";
import { orpc } from "@/lib/orpc";
import { useVibestClientRpcContext } from "@/rpc/vibest-client-rpc-context";

const models = createListCollection<{
  label: "Opus" | "Sonnet";
  value: "opus" | "sonnet";
}>({
  items: [
    {
      label: "Opus",
      value: "opus",
    },
    {
      label: "Sonnet",
      value: "sonnet",
    },
  ],
});

function formatInspectedTitle(metadata?: InspectMetadata) {
  const filename = getFilenameFromPath(metadata?.fileName);
  const column = metadata?.columnNumber;
  const line = metadata?.lineNumber;

  return `${filename}:${line}:${column}`;
}

export function Chat({ className }: { className?: string }) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<"opus" | "sonnet">("sonnet");
  const { sessionId } = useToolbarContext();

  const { connected } = useVibestClientRpcContext();
  const inspectedTargets = useSelector(
    inspectorStoreSync,
    (snapshot) => snapshot.context.inspectedTargets,
  );
  const inspectorState = useSelector(inspectorStoreSync, (snapshot) => snapshot.context.state);

  const { messages, sendMessage, status } = useChat<ClaudeCodeUIMessage>({
    transport: {
      async sendMessages(options) {
        if (!sessionId.current) {
          const result = await orpc.claudeCode.session.create();
          sessionId.current = result.sessionId;
          // TODO: Store and use the additional session data
          // result.supportedCommands, result.supportedModels, result.mcpServers
        }
        const message = options.messages.at(-1);
        if (!message) {
          throw new Error("message is required");
        }
        const event = await orpc.claudeCode.prompt(
          { sessionId: sessionId.current, message },
          { signal: options.abortSignal },
        );
        return eventIteratorToStream(event);
      },
      reconnectToStream() {
        throw new Error("Unsupported yet");
      },
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!input.trim()) return;

    if (inspectedTargets.length > 0) {
      sendMessage({
        parts: [
          {
            type: "data-inspector",
            data: inspectedTargets.map((target) => ({
              file: target.metadata.fileName,
              line: target.metadata.lineNumber,
              column: target.metadata.columnNumber,
              component: target.metadata.componentName,
            })),
          },
          {
            type: "text",
            text: input,
          },
        ],
      });
    } else {
      sendMessage({
        parts: [{ type: "text", text: input }],
      });
    }

    inspectorStoreSync.trigger.STOP();
    inspectorStoreSync.trigger.CLEAR_INSPECTED_TARGETS();
    setInput("");
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <Conversation>
        <ConversationContent>
          {messages.map((message) => (
            <ClaudeCodeMessageParts key={message.id} message={message} />
          ))}
          {status === "submitted" && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="flex-shrink-0 p-2">
        <PromptInput onSubmit={handleSubmit}>
          {inspectedTargets.length ? (
            <div className="flex max-h-14 w-full flex-wrap gap-1 overflow-y-auto p-1.5">
              {inspectedTargets.map((target) => {
                const title = formatInspectedTitle(target.metadata);
                return (
                  <Badge
                    key={target.id}
                    variant="outline"
                    className="flex h-6 max-w-[200px] items-center gap-1 truncate px-1.5 text-xs"
                    title={title}
                  >
                    <Button
                      variant="ghost"
                      className="size-2 p-0!"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        inspectorStoreSync.trigger.REMOVE_INSPECTED_TARGET({
                          id: target.id,
                        });
                      }}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                    <span className="min-w-0 truncate">{title}</span>
                  </Badge>
                );
              })}
            </div>
          ) : null}
          <PromptInputTextarea
            className="min-h-4"
            onChange={(e) => setInput(e.target.value)}
            value={input}
          />
          <PromptInputToolbar>
            <PromptInputTools>
              <Select
                className="relative"
                collection={models}
                value={[model]}
                onValueChange={(details) => {
                  setModel(details.value[0] as "opus" | "sonnet");
                }}
              >
                <SelectControl className="min-h-8">
                  <SelectTrigger className="py-0">
                    <SelectValueText />
                  </SelectTrigger>
                </SelectControl>
                <SelectContent>
                  {models.items.map((model) => (
                    <SelectItem key={model.value} item={model}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={inspectorState === "idle" ? "ghost" : "default"}
                data-state={inspectorState}
                size="sm"
                disabled={!connected}
                onClick={() => {
                  if (inspectorState === "idle") {
                    inspectorStoreSync.trigger.START();
                  } else {
                    inspectorStoreSync.trigger.STOP();
                  }
                }}
              >
                <MousePointerClickIcon />
              </Button>
            </PromptInputTools>
            <PromptInputSubmit size="sm" disabled={!input} status={status} />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
}
