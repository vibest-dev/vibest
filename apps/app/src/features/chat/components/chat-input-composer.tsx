import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Button } from "@vibest/ui/components/button";
import { Card, CardFrame, CardFrameHeader } from "@vibest/ui/components/card";
import type { ReactNode } from "react";
import { useStore } from "zustand";

import type { OutgoingMessage } from "@/features/chat/runtime/chat-state";

import { useChatSession } from "./chat-session-context";
import { ChatInput } from "./input/chat-input";
import { ChatInputProvider } from "./input/chat-input-provider";
import { createChatBaseExtensions } from "./input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "./input/extensions/keymaps";
import { useChatInputController } from "./input/use-chat-input-controller";
import { useChatInputHasContent } from "./input/use-chat-input-has-content";

function QueuedPromptList({
  messages,
  canSteer,
  onSteer,
}: {
  messages: OutgoingMessage[];
  canSteer: boolean;
  onSteer: (messageId: string) => void;
}) {
  let followUpIndex = 0;
  return (
    <ol
      aria-label="Queued prompts"
      aria-live="polite"
      className="max-h-48 w-full scrollbar-thin space-y-2 overflow-y-auto"
    >
      {messages.map((outgoing) => {
        const text = outgoing.message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        if (outgoing.delivery === "follow-up") followUpIndex += 1;
        const label =
          outgoing.status === "failed"
            ? "Steer failed"
            : outgoing.delivery === "steer"
              ? outgoing.status === "sending"
                ? "Steering…"
                : "Steer"
              : `Follow-up · ${followUpIndex}`;
        return (
          <li
            key={outgoing.message.id}
            data-slot="queued-user-message"
            className="flex min-w-0 items-center gap-3 text-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={text}>
              {text}
            </span>
            {canSteer && outgoing.delivery === "follow-up" && outgoing.status === "queued" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto shrink-0 px-1.5 py-0 text-xs"
                onClick={() => onSteer(outgoing.message.id)}
              >
                Steer
              </Button>
            )}
            <span
              className={
                outgoing.status === "failed"
                  ? "text-destructive shrink-0 text-xs"
                  : "text-muted-foreground shrink-0 text-xs"
              }
              title={outgoing.error?.message}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ChatInputComposer({ toolbar }: { toolbar?: ReactNode }) {
  const { prompt, steer, turnInProgress, store } = useChatSession();
  const status = useStore(store, (state) => state.session.status);
  const activeTurnId = useStore(store, (state) => state.session.activeTurnId);
  const outgoing = useStore(store, (state) => state.outgoing);

  const controller = useChatInputController({
    extensions: (self) => [
      ...createChatBaseExtensions(),
      createSubmitKeymap({ onSubmit: () => void self.submit() }),
    ],
    onSubmit: (text) => {
      void prompt(text).catch(() => undefined);
      return;
    },
  });

  const hasContent = useChatInputHasContent(controller);
  const canSteer = activeTurnId !== null;

  return (
    <CardFrame>
      {outgoing.length > 0 && (
        <CardFrameHeader className="p-3">
          <QueuedPromptList messages={outgoing} canSteer={canSteer} onSteer={steer} />
        </CardFrameHeader>
      )}
      <Card
        render={
          <PromptInput
            onSubmit={(event) => {
              event.preventDefault();
              void controller?.submit();
            }}
          />
        }
      >
        <ChatInputProvider controller={controller}>
          <ChatInput />
          <PromptInputToolbar>
            <PromptInputTools>{toolbar}</PromptInputTools>
            <PromptInputSubmit disabled={!hasContent} status={turnInProgress ? "ready" : status} />
          </PromptInputToolbar>
        </ChatInputProvider>
      </Card>
    </CardFrame>
  );
}
