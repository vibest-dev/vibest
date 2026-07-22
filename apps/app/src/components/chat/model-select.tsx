import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

import type { SessionConfigOption } from "@/core/harness/session-config";

// Presentational model picker: value/onChange driven so it composes both inside
// a session (ChatModelSelect binds it to ChatSession context) and on the draft
// surface (URL search params, no session yet).
//
// The options come from the harness's negotiated capabilities, never from a
// list in here: the catalog follows the signed-in account and the installed
// CLI, so a hardcoded one is a claim the harness never made. An empty list
// means the harness has no model switch (pi) — render nothing rather than an
// empty dropdown.
export function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: ReadonlyArray<SessionConfigOption>;
  value: string | undefined;
  onChange: (model: string) => void;
}) {
  if (models.length === 0) return null;

  const items = models.map((model) => ({ label: model.label, value: model.id }));

  return (
    <PromptInputModelSelect
      items={items}
      value={value ?? null}
      onValueChange={(next) => {
        if (next) onChange(String(next));
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue />
      </PromptInputModelSelectTrigger>
      <PromptInputModelSelectContent>
        {models.map((model) => (
          <PromptInputModelSelectItem key={model.id} value={model.id}>
            {model.label}
          </PromptInputModelSelectItem>
        ))}
      </PromptInputModelSelectContent>
    </PromptInputModelSelect>
  );
}
