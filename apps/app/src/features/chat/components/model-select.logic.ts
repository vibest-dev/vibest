import type { ProviderInfo } from "@vibest/contract";

export type ModelOption = {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly label: string;
};

export type ModelGroup = {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly items: ModelOption[];
};

export function modelOptionsFrom(providers: ReadonlyArray<ProviderInfo>): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.label ?? provider.id,
      modelId: model.id,
      label: model.label ?? model.id,
    })),
  );
}

export function modelGroupsFrom(options: ReadonlyArray<ModelOption>): ModelGroup[] {
  const byProvider = new Map<string, ModelOption[]>();
  const labels = new Map<string, string>();
  for (const option of options) {
    const items = byProvider.get(option.providerId) ?? [];
    items.push(option);
    byProvider.set(option.providerId, items);
    labels.set(option.providerId, option.providerLabel);
  }
  return [...byProvider].map(([providerId, items]) => ({
    items,
    providerId,
    providerLabel: labels.get(providerId) ?? providerId,
  }));
}

export function findModelOption(
  options: ReadonlyArray<ModelOption>,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelOption | null {
  return (
    options.find((option) => option.providerId === providerId && option.modelId === modelId) ?? null
  );
}

export function modelOptionMatches(
  option: ModelOption,
  query: string,
  contains: (haystack: string, needle: string) => boolean,
): boolean {
  if (query.trim() === "") return true;
  return (
    contains(option.label, query) ||
    contains(option.modelId, query) ||
    contains(option.providerLabel, query) ||
    contains(option.providerId, query)
  );
}

export function filterModelGroups(
  groups: ReadonlyArray<ModelGroup>,
  query: string,
  contains: (haystack: string, needle: string) => boolean,
): ModelGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((option) => modelOptionMatches(option, query, contains)),
    }))
    .filter((group) => group.items.length > 0);
}
