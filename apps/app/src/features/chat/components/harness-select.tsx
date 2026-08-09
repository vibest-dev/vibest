import type { HarnessAgentId } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";
import { ChevronDownIcon } from "lucide-react";

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
      <PromptInputModelSelectTrigger className="group hover:bg-accent data-pressed:bg-accent min-h-8 border-0 bg-transparent px-3 py-0 shadow-none not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-none dark:bg-transparent dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-none [&>[data-slot=select-icon]]:hidden">
        <PromptInputModelSelectValue className="flex min-w-0 items-center gap-2">
          <HarnessIcon className="size-4 shrink-0" harnessAgentId={value} />
          <span className="truncate">{selectedHarnessAgent?.name ?? value}</span>
        </PromptInputModelSelectValue>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 opacity-70 transition-transform group-data-[popup-open]:rotate-180"
        />
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
