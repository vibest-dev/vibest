import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { ChatPermissionMode } from "@/core/chat/chat-config";

// claude-code's outward permission-mode ids, hardcoded for now — the app is
// single-harness (claude-code). Once it can pick a harness, these should come
// from that harness's capabilities.permissionModes.
const modes: { label: string; value: ChatPermissionMode }[] = [
  { label: "Plan", value: "plan" },
  { label: "Ask", value: "ask" },
  { label: "Accept edits", value: "acceptEdits" },
  { label: "Full access", value: "full" },
];

// Presentational permission-mode picker: value/onChange driven so it composes
// both inside a session (ChatPermissionModeSelect binds it to ChatSession
// context) and on the draft surface (local state, no session yet). Each id is
// an outward permission-mode id the harness maps to its native system.
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
