import type { ProviderInfo } from "@vibest/contract";
import { Button } from "@vibest/ui/components/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxFilter,
} from "@vibest/ui/components/combobox";
import { ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

interface ModelOption {
  provider: string;
  providerLabel: string;
  modelId: string;
  label: string;
}

interface ModelGroup {
  provider: string;
  providerLabel: string;
  items: ModelOption[];
}

// Presentational model picker: value/onChange driven so it composes both inside
// a session (ChatModelSelect binds it to ChatSession context) and on the draft
// surface (URL search params, no session yet).
//
// Options come from the probed providers, never from a list in here. Model ids
// are scoped to their provider; the pair always travels together. Models are
// grouped by provider and the popup filters as you type. An empty list means
// the harness has no model switch (pi) — render nothing rather than an empty
// dropdown.
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
  const filter = useComboboxFilter();

  const options = useMemo<ModelOption[]>(
    () =>
      providers.flatMap((provider) =>
        provider.models.map((model) => ({
          provider: provider.id,
          providerLabel: provider.label ?? provider.id,
          modelId: model.id,
          label: model.label ?? model.id,
        })),
      ),
    [providers],
  );

  const groups = useMemo<ModelGroup[]>(() => {
    const byProvider = new Map<string, ModelOption[]>();
    const labels = new Map<string, string>();
    for (const option of options) {
      const groupItems = byProvider.get(option.provider) ?? [];
      groupItems.push(option);
      byProvider.set(option.provider, groupItems);
      labels.set(option.provider, option.providerLabel);
    }
    return [...byProvider].map(([provider, items]) => ({
      items,
      provider,
      providerLabel: labels.get(provider) ?? provider,
    }));
  }, [options]);

  const value = useMemo(
    () =>
      options.find((option) => option.provider === providerId && option.modelId === modelId) ??
      null,
    [options, providerId, modelId],
  );

  // Search matches the display name, the raw model id, and the provider group.
  const matchesQuery = useCallback(
    (option: ModelOption, query: string) =>
      filter.contains(option.label, query) ||
      filter.contains(option.modelId, query) ||
      filter.contains(option.provider, query) ||
      filter.contains(option.providerLabel, query),
    [filter],
  );

  if (options.length === 0) return null;

  return (
    <Combobox
      autoHighlight
      filter={matchesQuery}
      items={groups}
      onValueChange={(option) => {
        if (option) onChange(option.provider, option.modelId);
      }}
      value={value}
    >
      <ComboboxTrigger
        className="data-placeholder:text-muted-foreground min-w-0"
        render={<Button className="min-h-8 py-0" size="sm" variant="ghost" />}
      >
        <ComboboxValue placeholder="Default">
          {(option: ModelOption | null) => (
            <span className="truncate">{option ? option.label : "Default"}</span>
          )}
        </ComboboxValue>
        <ChevronsUpDownIcon />
      </ComboboxTrigger>
      <ComboboxPopup className="min-w-64">
        <div className="border-b px-2 py-1.5">
          <ComboboxInput
            autoFocus
            className="border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0"
            placeholder="Search models…"
            showTrigger={false}
            size="sm"
            startAddon={<SearchIcon />}
          />
        </div>
        <ComboboxEmpty className="text-muted-foreground text-center text-sm">
          No matching models.
        </ComboboxEmpty>
        <div className="min-h-0 flex-1">
          <ComboboxList>
            {(group: ModelGroup) => (
              <ComboboxGroup items={group.items} key={group.provider}>
                <ComboboxGroupLabel>{group.providerLabel}</ComboboxGroupLabel>
                <ComboboxCollection>
                  {(option: ModelOption) => (
                    <ComboboxItem key={`${option.provider}:${option.modelId}`} value={option}>
                      {option.label}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
