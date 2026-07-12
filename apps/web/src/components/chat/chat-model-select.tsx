import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import { useChatSession, type ChatModel } from "./chat-session-context";

const models = [
  { label: "Opus", value: "opus" as const },
  { label: "Sonnet", value: "sonnet" as const },
];

// Session-config slot: reads model/setModel from the ChatSession context so it
// can be composed anywhere inside ChatSessionProvider (e.g. the composer toolbar).
export function ChatModelSelect() {
  const { model, setModel } = useChatSession();
  return (
    <PromptInputModelSelect
      items={models}
      value={model}
      onValueChange={(value) => {
        if (value) setModel(value as ChatModel);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {models.map((m) => (
          <PromptInputModelSelectItem key={m.value} value={m.value}>
            {m.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
