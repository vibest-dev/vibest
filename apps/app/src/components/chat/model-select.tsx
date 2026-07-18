import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { ChatModel } from "@/core/chat/chat-config";

const models = [
  { label: "Opus", value: "opus" as const },
  { label: "Sonnet", value: "sonnet" as const },
];

// Presentational model picker: value/onChange driven so it composes both inside
// a session (ChatModelSelect binds it to ChatSession context) and on the draft
// surface (local state, no session yet). Single source for the model list.
export function ModelSelect({
  value,
  onChange,
}: {
  value: ChatModel;
  onChange: (model: ChatModel) => void;
}) {
  return (
    <PromptInputModelSelect
      items={models}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ChatModel);
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
