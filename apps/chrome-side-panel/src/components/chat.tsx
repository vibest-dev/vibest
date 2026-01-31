"use client";

import type { InspectedTargetData } from "@vibest/code-inspector-web";

import { useChat } from "@ai-sdk/react";
import { VibestExtensionMessage } from "@vibest/shared/extension/message";
import { Action, Actions } from "@vibest/ui/ai-elements/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@vibest/ui/ai-elements/conversation";
import { Loader } from "@vibest/ui/ai-elements/loader";
import { Message, MessageContent } from "@vibest/ui/ai-elements/message";
import {
  PromptInput,
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@vibest/ui/ai-elements/reasoning";
import { Response } from "@vibest/ui/ai-elements/response";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@vibest/ui/ai-elements/sources";
import { Suggestion, Suggestions } from "@vibest/ui/ai-elements/suggestion";
import { CopyIcon, RefreshCcwIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import invariant from "tiny-invariant";
import { onMessage } from "webext-bridge/sidepanel";

import { useORPC } from "@/context";

const models = [
  {
    name: "Opus",
    value: "anthropic/opus-4.1",
  },
  {
    name: "Sonnet",
    value: "anthropic/sonnet-4",
  },
];

export function Chat() {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>(models[0].value);
  const { orpc } = useORPC();
  const [inspectedTargets, setInspectedTargets] = useState<InspectedTargetData[]>([]);
  const { messages, sendMessage, status, regenerate } = useChat({
    transport: {
      async sendMessages(_options) {
        // this should not happen, for type safe
        invariant(orpc, "local server not set correctly");
        // const event = await orpc.http.chat(
        // 	{
        // 		chatId: options.chatId,
        // 		messages: options.messages,
        // 	},
        // 	{ signal: options.abortSignal },
        // );
        // return eventIteratorToStream(event);
      },
      reconnectToStream() {
        throw new Error("Unsupported yet");
      },
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage(
        { text: input },
        {
          body: {
            model: model,
          },
        },
      );
      setInput("");
    }
  };

  useEffect(() => {
    const unsubscribe = onMessage(VibestExtensionMessage.Inspected, ({ data }) => {
      setInspectedTargets(data.targets);
      const lastTarget = data.targets.at(-1);
      if (!lastTarget) {
        return;
      }
      const text = `@${lastTarget.metadata.fileName}:${lastTarget.metadata.lineNumber}:${lastTarget.metadata.columnNumber}`;
      if (!input.includes(text)) {
        setInput(text);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [input]);

  return (
    <div className="relative mx-auto size-full h-screen max-w-4xl p-2">
      <div className="flex h-full flex-col">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.map((message) => (
              <div key={message.id}>
                {message.role === "assistant" &&
                  message.parts.filter((part) => part.type === "source-url").length > 0 && (
                    <Sources>
                      <SourcesTrigger
                        count={message.parts.filter((part) => part.type === "source-url").length}
                      />
                      {message.parts
                        .filter((part) => part.type === "source-url")
                        .map((part, i) => (
                          <SourcesContent key={`${message.id}-${i}`}>
                            <Source key={`${message.id}-${i}`} href={part.url} title={part.url} />
                          </SourcesContent>
                        ))}
                    </Sources>
                  )}
                {message.parts.map((part, i) => {
                  switch (part.type) {
                    case "text":
                      return (
                        <Fragment key={`${message.id}-${i}`}>
                          <Message from={message.role}>
                            <MessageContent>
                              <Response>{part.text}</Response>
                            </MessageContent>
                          </Message>
                          {message.role === "assistant" && i === messages.length - 1 && (
                            <Actions className="mt-2">
                              <Action onClick={() => regenerate()} label="Retry">
                                <RefreshCcwIcon className="size-3" />
                              </Action>
                              <Action
                                onClick={() => navigator.clipboard.writeText(part.text)}
                                label="Copy"
                              >
                                <CopyIcon className="size-3" />
                              </Action>
                            </Actions>
                          )}
                        </Fragment>
                      );
                    case "reasoning":
                      return (
                        <Reasoning
                          key={`${message.id}-${i}`}
                          className="w-full"
                          isStreaming={
                            status === "streaming" &&
                            i === message.parts.length - 1 &&
                            message.id === messages.at(-1)?.id
                          }
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    default:
                      return null;
                  }
                })}
              </div>
            ))}
            {status === "submitted" && <Loader />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {!!inspectedTargets.length && (
          <Suggestions>
            {inspectedTargets.map((target) => (
              <Suggestion key={target.id} suggestion={target.metadata.componentName}>
                {target.metadata.componentName}
              </Suggestion>
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={handleSubmit} className="mt-4">
          <PromptInputTextarea onChange={(e) => setInput(e.target.value)} value={input} />
          <PromptInputToolbar>
            <PromptInputTools>
              <PromptInputModelSelect
                onValueChange={(value) => {
                  setModel(value);
                }}
                value={model}
              >
                <PromptInputModelSelectTrigger>
                  <PromptInputModelSelectValue />
                </PromptInputModelSelectTrigger>
                <PromptInputModelSelectContent>
                  {models.map((model) => (
                    <PromptInputModelSelectItem key={model.value} value={model.value}>
                      {model.name}
                    </PromptInputModelSelectItem>
                  ))}
                </PromptInputModelSelectContent>
              </PromptInputModelSelect>
            </PromptInputTools>
            <PromptInputSubmit disabled={!input} status={status} />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
}
