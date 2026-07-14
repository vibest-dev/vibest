import { useEditorState } from "@tiptap/react";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import type { ReactNode } from "react";
import { useStore } from "zustand";

import { useLatestRef } from "@/hooks/use-latest-ref";

import { useChatSession } from "./chat-session-context";
import { ChatInput } from "./input/chat-input";
import { ChatInputProvider, useChatInputController } from "./input/chat-input-provider";
import { createChatBaseExtensions } from "./input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "./input/extensions/keymaps";
import { hasChatContent } from "./input/serialize";

// Live-session input bar on the TipTap chat-input kit: Enter sends (IME-safe,
// handled by the submit keymap) / Shift+Enter breaks the line; an in-flight
// turn blocks sending but not typing (onSubmit returns false → content stays).
// prompt/turnInProgress come from ChatSessionProvider — not props.
// toolbar = surface-composed toolbar content (e.g. <ChatModelSelect/>).
export function ChatInputComposer({ toolbar }: { toolbar?: ReactNode }) {
  const { prompt, turnInProgress, store } = useChatSession();
  const status = useStore(store, (s) => s.status);
  const turnInProgressRef = useLatestRef(turnInProgress);

  const controller = useChatInputController({
    // Order is a hard constraint: base extensions first, submit keymap last —
    // otherwise bare Enter is consumed by the default newline behavior before
    // the keymap ever sees it.
    extensions: (self) => [
      ...createChatBaseExtensions({ placeholder: () => "Ask Claude Code anything..." }),
      createSubmitKeymap({ onSubmit: () => void self.submit() }),
    ],
    onSubmit: (text) => {
      // Turn in progress: don't send, don't clear.
      if (turnInProgressRef.current) return false;
      prompt(text);
      return;
    },
  });

  const hasContent = useEditorState({
    editor: controller?.editor ?? null,
    selector: ({ editor }) => (editor ? hasChatContent(editor) : false),
  });

  return (
    <PromptInput
      onSubmit={(e) => {
        e.preventDefault();
        void controller?.submit();
      }}
    >
      <ChatInputProvider controller={controller}>
        <ChatInput />
        <PromptInputToolbar>
          <PromptInputTools>{toolbar}</PromptInputTools>
          <PromptInputSubmit disabled={!hasContent || turnInProgress} status={status} />
        </PromptInputToolbar>
      </ChatInputProvider>
    </PromptInput>
  );
}
