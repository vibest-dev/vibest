import type { HarnessAgentId } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import { useHarnessAgents } from "@/features/chat/harness/use-harness";

import { HarnessIcon } from "./harness-icon";

// Which agent runs the session. Only offered before the session exists: the
// harness is part of the SessionRef, so it is fixed at create time (see
// ChatHarnessIcon for how a live session shows it).
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
  const selectedHarnessAgent = harnessAgents.find((harnessAgent) => harnessAgent.id === value);

  return (
    <PromptInputModelSelect
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as HarnessAgentId);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue className="flex min-w-0 items-center gap-2">
          <HarnessIcon className="size-4 shrink-0" harnessAgentId={value} />
          <span className="truncate">{selectedHarnessAgent?.name ?? value}</span>
        </PromptInputModelSelectValue>
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {harnessAgents.map((harnessAgent) => (
          <PromptInputModelSelectItem
            key={harnessAgent.id}
            value={harnessAgent.id}
            disabled={!harnessAgent.available}
          >
            <span className="flex min-w-0 items-start gap-2">
              <HarnessIcon className="mt-0.5 size-4 shrink-0" harnessAgentId={harnessAgent.id} />
              <span className="min-w-0 truncate">
                {harnessAgent.name}
                {harnessAgent.reason ? (
                  <small className="text-muted-foreground block truncate text-xs">
                    {harnessAgent.reason}
                  </small>
                ) : null}
              </span>
            </span>
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
