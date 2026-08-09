import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Card, CardFrame, CardFrameHeader } from "@vibest/ui/components/card";
import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import { useStore } from "zustand";

import { useChatSession } from "./chat-session-context";
import { ChatInput } from "./input/chat-input";
import { ChatInputProvider } from "./input/chat-input-provider";
import { createChatBaseExtensions } from "./input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "./input/extensions/keymaps";
import { useChatInputController } from "./input/use-chat-input-controller";
import { useChatInputHasContent } from "./input/use-chat-input-has-content";

function QueuedPromptList({ messages }: { messages: UIMessage[] }) {
  return (
    <ol
      aria-label="Queued prompts"
      aria-live="polite"
      className="max-h-48 w-full scrollbar-thin space-y-2 overflow-y-auto"
    >
      {messages.map((message, index) => {
        const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
        return (
          <li
            key={message.id}
            data-slot="queued-user-message"
            className="flex min-w-0 items-center gap-3 text-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={text}>
              {text}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">Queued · {index + 1}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Live-session input bar on the TipTap chat-input kit: Enter sends (IME-safe,
// handled by the submit keymap) / Shift+Enter breaks the line. Prompts submitted
// during an active turn enter Chat's client-local FIFO instead of being blocked.
// prompt/turnInProgress come from ChatSessionProvider — not props.
// toolbar = surface-composed toolbar content (e.g. <ChatModelSelect/>).
export function ChatInputComposer({ toolbar }: { toolbar?: ReactNode }) {
  const { prompt, turnInProgress, store } = useChatSession();
  const status = useStore(store, (s) => s.status);
  const queuedMessages = useStore(store, (s) => s.queuedMessages);

  const controller = useChatInputController({
    // Order is a hard constraint: base extensions first, submit keymap last —
    // otherwise bare Enter is consumed by the default newline behavior before
    // the keymap ever sees it.
    extensions: (self) => [
      ...createChatBaseExtensions(),
      createSubmitKeymap({ onSubmit: () => void self.submit() }),
    ],
    onSubmit: (text) => {
      // The composer clears once the message is accepted into the local queue;
      // the promise may settle later when this item reaches the server.
      void prompt(text).catch(() => undefined);
      return;
    },
  });

  const hasContent = useChatInputHasContent(controller);

  return (
    <CardFrame>
      {queuedMessages.length > 0 && (
        <CardFrameHeader className="p-3">
          <QueuedPromptList messages={queuedMessages} />
        </CardFrameHeader>
      )}
      <Card
        render={
          <PromptInput
            onSubmit={(e) => {
              e.preventDefault();
              void controller?.submit();
            }}
          />
        }
      >
        <ChatInputProvider controller={controller}>
          <ChatInput />
          <PromptInputToolbar>
            <PromptInputTools>{toolbar}</PromptInputTools>
            <PromptInputSubmit
              disabled={!hasContent}
              // During a turn this button enqueues rather than interrupts, so the
              // send arrow is the truthful affordance instead of the stop square.
              status={turnInProgress ? "ready" : status}
            />
          </PromptInputToolbar>
        </ChatInputProvider>
      </Card>
    </CardFrame>
  );
}
