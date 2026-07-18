import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { ChatPermissionMode } from "@/core/chat/chat-config";

const modes: { label: string; value: ChatPermissionMode }[] = [
  { label: "Ask", value: "default" },
  { label: "Accept edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
  { label: "Bypass", value: "bypass" },
];

// Presentational permission-mode picker: value/onChange driven so it composes
// both inside a session (ChatPermissionModeSelect binds it to ChatSession
// context) and on the draft surface (local state, no session yet). The modes
// are the harness-agnostic PermissionMode vocabulary; each harness maps them to
// its own approval system server-side.
export function PermissionModeSelect({
  value,
  onChange,
}: {
  value: ChatPermissionMode;
  onChange: (mode: ChatPermissionMode) => void;
}) {
  return (
    <PromptInputModelSelect
      items={modes}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ChatPermissionMode);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {modes.map((m) => (
          <PromptInputModelSelectItem key={m.value} value={m.value}>
            {m.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
