import type { ProviderInfo } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";

// Presentational model picker: value/onChange driven so it composes both inside
// a session (ChatModelSelect binds it to ChatSession context) and on the draft
// surface (URL search params, no session yet).
//
// The options come from the probed providers, never from a list in here: the
// catalogue follows the signed-in account and the installed CLI, so a hardcoded
// one is a claim the provider never made. Model ids are opaque and atomic —
// this component renders `label ?? id` and echoes the providerId/modelId pair
// back, nothing more. An empty list means the harness has no model switch (pi)
// — render nothing rather than an empty dropdown.
export function ModelSelect({
  providers,
  providerId,
  modelId,
  onChange,
}: {
  providers: ReadonlyArray<ProviderInfo>;
  providerId: string | undefined;
  modelId: string | undefined;
  onChange: (providerId: string, modelId: string) => void;
}) {
  // Today a session sees a single provider, so the grouping is invisible; with
  // more than one, the provider label prefixes the model so same-named models
  // stay tellable apart. The pair always travels together — modelId is only
  // unique within its provider.
  const populated = providers.filter((provider) => provider.models.length > 0);
  const showProvider = populated.length > 1;
  const options = populated.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: showProvider
        ? `${provider.label ?? provider.id} · ${model.label ?? model.id}`
        : (model.label ?? model.id),
    })),
  );
  if (options.length === 0) return null;

  // Select values must be strings; the index is the one encoding that can't
  // collide with id contents (ids are atomic — never parsed or joined).
  const selectedIndex = options.findIndex(
    (option) => option.providerId === providerId && option.modelId === modelId,
  );
  const items = options.map((option, index) => ({ label: option.label, value: String(index) }));

  return (
    <PromptInputModelSelect
      items={items}
      value={selectedIndex >= 0 ? String(selectedIndex) : null}
      onValueChange={(next) => {
        const option = next === null ? undefined : options[Number(next)];
        if (option) onChange(option.providerId, option.modelId);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        {/* No pick is a real state, not a loading gap: the wire omits the
            field and the harness runs its own configured default. */}
        <PromptInputModelSelectValue placeholder="Default" />
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
