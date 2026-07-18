import type { HarnessAgentId } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { ChatPermissionMode } from "@/core/chat/chat-config";
import { useHarnessAgent } from "@/core/harness/use-harness-negotiation";

// Presentational permission-mode picker: value/onChange driven so it composes
// both inside a session (ChatPermissionModeSelect binds it to ChatSession
// context) and on the draft surface (local state, no session yet). The options
// come from the harness's negotiated capabilities — each id is an outward
// permission-mode id the harness maps to its own native system.
export function PermissionModeSelect({
  harnessAgentId,
  value,
  onChange,
}: {
  harnessAgentId: HarnessAgentId;
  value: ChatPermissionMode;
  onChange: (mode: ChatPermissionMode) => void;
}) {
  // Read this harness's slice of the once-negotiated result — no fetch here.
  const modes = useHarnessAgent(harnessAgentId)?.capabilities.permissionModes ?? [];

  return (
    <PromptInputModelSelect
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as ChatPermissionMode);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {modes.map((mode) => (
          <PromptInputModelSelectItem key={mode.id} value={mode.id}>
            {mode.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
