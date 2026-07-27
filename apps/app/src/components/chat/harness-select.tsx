import type { HarnessAgentId } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import { useHarnessAgents } from "@/core/harness/use-harness";

// Which agent runs the session. Only offered before the session exists: the
// harness is part of the SessionRef, so it is fixed at create time (see
// HarnessBadge for how a live session shows it).
//
// Harnesses whose CLI is missing stay in the list, disabled and labelled with
// the declared `reason` — hiding them turns "why is Codex not here?" into a
// dead end, where "Codex was not found on PATH." is something the user can act
// on.
export function HarnessSelect({
  value,
  onChange,
}: {
  value: HarnessAgentId;
  onChange: (harnessAgentId: HarnessAgentId) => void;
}) {
  const harnessAgents = useHarnessAgents();
  const items = harnessAgents.map((harnessAgent) => ({
    label: harnessAgent.name,
    value: harnessAgent.id,
  }));

  return (
    <PromptInputModelSelect
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as HarnessAgentId);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {harnessAgents.map((harnessAgent) => (
          <PromptInputModelSelectItem
            key={harnessAgent.id}
            value={harnessAgent.id}
            disabled={!harnessAgent.available}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{harnessAgent.name}</span>
              {harnessAgent.reason ? (
                <span className="text-muted-foreground truncate text-xs">
                  {harnessAgent.reason}
                </span>
              ) : null}
            </span>
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
