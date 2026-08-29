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
import { useMemo, useState } from "react";

import {
  filterModelGroups,
  findModelOption,
  modelGroupsFrom,
  modelOptionsFrom,
  type ModelOption,
} from "./model-select.logic";

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
  const [query, setQuery] = useState("");
  const options = useMemo(() => modelOptionsFrom(providers), [providers]);
  const groups = useMemo(() => modelGroupsFrom(options), [options]);
  const visibleGroups = useMemo(
    () => filterModelGroups(groups, query, filter.contains),
    [filter, groups, query],
  );
  const value = useMemo(
    () => findModelOption(options, providerId, modelId),
    [options, providerId, modelId],
  );

  if (options.length === 0) return null;

  return (
    <Combobox
      autoHighlight
      filter={null}
      inputValue={query}
      isItemEqualToValue={(left, right) =>
        left.providerId === right.providerId && left.modelId === right.modelId
      }
      itemToStringLabel={(option) => option.label}
      items={options}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(option) => {
        if (option) onChange(option.providerId, option.modelId);
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
        {visibleGroups.length === 0 ? (
          <ComboboxEmpty className="text-muted-foreground text-center text-sm">
            No matching models.
          </ComboboxEmpty>
        ) : (
          <div className="min-h-0 flex-1">
            <ComboboxList>
              {visibleGroups.map((group) => (
                <ComboboxGroup items={group.items} key={group.providerId}>
                  <ComboboxGroupLabel>{group.providerLabel}</ComboboxGroupLabel>
                  <ComboboxCollection>
                    {(option: ModelOption) => (
                      <ComboboxItem key={`${option.providerId}:${option.modelId}`} value={option}>
                        {option.label}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              ))}
            </ComboboxList>
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
