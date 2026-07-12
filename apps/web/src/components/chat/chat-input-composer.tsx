import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { useState, type ReactNode } from "react";

import { useChatSession } from "./chat-session-context";

// Live-session input bar: Enter sends / Shift+Enter breaks the line (handled
// by PromptInputTextarea), an in-flight turn blocks sending but not typing.
// prompt/turnInProgress come from ChatSessionProvider — not props.
// toolbar = surface-composed toolbar content (e.g. <ChatModelSelect/>).
// Textarea-based for now; a TipTap rewrite can swap the internals without
// touching the composition around it.
export function ChatInputComposer({ toolbar }: { toolbar?: ReactNode }) {
  const { prompt, turnInProgress, status } = useChatSession();
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Turn in progress: don't send, don't clear.
    if (!input.trim() || turnInProgress) return;
    prompt(input);
    setInput("");
  };

  return (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea
        className="min-h-4"
        onChange={(e) => setInput(e.target.value)}
        value={input}
        placeholder="Ask Claude Code anything..."
      />
      <PromptInputToolbar>
        <PromptInputTools>{toolbar}</PromptInputTools>
        <PromptInputSubmit disabled={!input.trim() || turnInProgress} status={status} />
      </PromptInputToolbar>
    </PromptInput>
  );
}
