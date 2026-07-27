import type { ReasoningEffort } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import { REASONING_EFFORT_LABELS, orderReasoningEfforts } from "@/core/harness/reasoning-efforts";

// Presentational reasoning-reasoningEffort picker. Its candidates cascade from the
// selected model's probed traits — not from the harness — so the caller passes
// them in; an empty list means the current model has no reasoningEffort switch and no
// control is rendered. Labels and ordering are client-owned: reasoningEffort names are
// vibest's vocabulary, like permission modes.
export function ReasoningEffortSelect({
  reasoningEfforts,
  value,
  onChange,
}: {
  reasoningEfforts: ReadonlyArray<ReasoningEffort>;
  value: ReasoningEffort | undefined;
  onChange: (reasoningEffort: ReasoningEffort) => void;
}) {
  if (reasoningEfforts.length === 0) return null;

  const ordered = orderReasoningEfforts(reasoningEfforts);
  const items = ordered.map((reasoningEffort) => ({
    label: REASONING_EFFORT_LABELS[reasoningEffort],
    value: reasoningEffort,
  }));

  return (
    <PromptInputModelSelect
      items={items}
      value={value ?? null}
      onValueChange={(next) => {
        const reasoningEffort = ordered.find((candidate) => candidate === next);
        if (reasoningEffort) onChange(reasoningEffort);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {items.map((item) => (
          <PromptInputModelSelectItem key={item.value} value={item.value}>
            {item.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
