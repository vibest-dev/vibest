import type { ProviderInfo } from "@vibest/contract";
import {
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
} from "@vibest/ui/ai-elements/prompt-input";
import { Button } from "@vibest/ui/components/button";

// Presentational model picker: value/onChange driven so it composes both inside
// a session (ChatModelSelect binds it to ChatSession context) and on the draft
// surface (URL search params, no session yet).
//
// The options come from the harness model list, never from values hardcoded in
// the client. Model ids are opaque and atomic — this component renders
// `label ?? id` and echoes the providerId/modelId pair back, nothing more. An
// empty list renders no control.
export function ModelSelect({
  providers,
  providerId,
  modelId,
  onChange,
  disabled = false,
  failed = false,
  onRetry,
}: {
  providers: ReadonlyArray<ProviderInfo>;
  providerId: string | undefined;
  modelId: string | undefined;
  onChange: (providerId: string, modelId: string) => void;
  disabled?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}) {
  // With more than one provider, the provider label prefixes the model so
  // same-named models stay tellable apart. The pair always travels together —
  // modelId is only unique within its provider.
  const populated = providers.filter((provider) => provider.models.length > 0);
  const showProvider = populated.length > 1;
  const listedOptions = populated.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: showProvider
        ? `${provider.label ?? provider.id} · ${model.label ?? model.id}`
        : (model.label ?? model.id),
    })),
  );
  // A session selection outlives catalog churn. Keep its opaque address
  // visible even when the latest list no longer contains it.
  const selectedListed = listedOptions.some(
    (option) => option.providerId === providerId && option.modelId === modelId,
  );
  const options =
    providerId !== undefined && modelId !== undefined && !selectedListed
      ? [
          {
            providerId,
            modelId,
            label: `${providerId} · ${modelId}`,
          },
          ...listedOptions,
        ]
      : listedOptions;
  if (failed) {
    return (
      <Button variant="ghost" size="sm" className="min-h-8" onClick={onRetry}>
        Retry models
      </Button>
    );
  }
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
      disabled={disabled}
      value={selectedIndex >= 0 ? String(selectedIndex) : null}
      onValueChange={(next) => {
        const option = next === null ? undefined : options[Number(next)];
        if (option) onChange(option.providerId, option.modelId);
      }}
    >
      <PromptInputModelSelectTrigger className="min-h-8 py-0">
        <PromptInputModelSelectValue placeholder="Model" />
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
