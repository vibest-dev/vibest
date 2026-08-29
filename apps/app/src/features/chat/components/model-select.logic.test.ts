import { describe, expect, it } from "vitest";

import {
  filterModelGroups,
  findModelOption,
  modelGroupsFrom,
  modelOptionMatches,
  modelOptionsFrom,
} from "./model-select.logic";

const contains = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const providers = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [{ id: "claude-opus", label: "Opus" }, { id: "claude-sonnet" }],
  },
  {
    id: "openai",
    models: [{ id: "gpt-5", label: "GPT-5" }],
  },
];

describe("model-select grouping", () => {
  it("keeps the provider/model pair and falls back to ids", () => {
    expect(modelOptionsFrom(providers)).toEqual([
      {
        providerId: "anthropic",
        providerLabel: "Anthropic",
        modelId: "claude-opus",
        label: "Opus",
      },
      {
        providerId: "anthropic",
        providerLabel: "Anthropic",
        modelId: "claude-sonnet",
        label: "claude-sonnet",
      },
      {
        providerId: "openai",
        providerLabel: "openai",
        modelId: "gpt-5",
        label: "GPT-5",
      },
    ]);
  });

  it("groups options by provider without flattening the key", () => {
    const groups = modelGroupsFrom(modelOptionsFrom(providers));
    expect(
      groups.map((group) => [group.providerId, group.items.map((item) => item.modelId)]),
    ).toEqual([
      ["anthropic", ["claude-opus", "claude-sonnet"]],
      ["openai", ["gpt-5"]],
    ]);
  });

  it("finds the selected pair", () => {
    const options = modelOptionsFrom(providers);
    expect(findModelOption(options, "anthropic", "claude-opus")?.label).toBe("Opus");
    expect(findModelOption(options, "anthropic", "missing")).toBeNull();
  });

  it("matches search against label, ids, and provider", () => {
    const opus = modelOptionsFrom(providers)[0]!;
    expect(modelOptionMatches(opus, "", contains)).toBe(true);
    expect(modelOptionMatches(opus, "opus", contains)).toBe(true);
    expect(modelOptionMatches(opus, "claude-opus", contains)).toBe(true);
    expect(modelOptionMatches(opus, "anthropic", contains)).toBe(true);
    expect(modelOptionMatches(opus, "gpt", contains)).toBe(false);
  });

  it("drops groups that have no matching models", () => {
    const groups = filterModelGroups(modelGroupsFrom(modelOptionsFrom(providers)), "gpt", contains);
    expect(groups).toEqual([
      {
        providerId: "openai",
        providerLabel: "openai",
        items: [
          {
            providerId: "openai",
            providerLabel: "openai",
            modelId: "gpt-5",
            label: "GPT-5",
          },
        ],
      },
    ]);
  });
});
