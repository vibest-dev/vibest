import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { HarnessAgentId } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { ChatPermissionMode } from "@/core/chat/chat-config";

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
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  // Harness capabilities are static per harness, so this resolves once and is
  // shared across every mount through the query cache.
  const { data } = useQuery(
    orpcQueryUtils.harness.capabilities.queryOptions({ input: { harnessAgentId } }),
  );
  const modes = data?.permissionModes ?? [];

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
