import type { HarnessAgentId, HarnessAgentInfo, ModelInfo, ProviderInfo } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { orderPermissionModes } from "./permission-modes";
import {
  findModelInfo,
  pickDefaultHarnessAgentId,
  resolveReasoningEffort,
  resolveModel,
  resolvePermissionMode,
} from "./session-config";

const claudeCode: HarnessAgentInfo = {
  id: "claude-code",
  name: "Claude Code",
  available: true,
  permissionModes: ["plan", "full"],
  defaultPermissionMode: "full",
};

// The other half, probed per directory rather than declared once. Models live
// inside their provider — the built-in provider carries the harness's id.
const claudeProviders: ReadonlyArray<ProviderInfo> = [
  {
    id: "claude-code",
    models: [
      // "Default (recommended)" is an ordinary pickable entry whose meaning is
      // "let the CLI decide" — not a preselection marker.
      { id: "default", label: "Default (recommended)" },
      { id: "sonnet", label: "Sonnet" },
    ],
  },
];

describe("resolveModel", () => {
  it("keeps a pick the catalog offers", () => {
    expect(resolveModel(claudeProviders, "claude-code", "sonnet")).toEqual({
      providerId: "claude-code",
      modelId: "sonnet",
    });
  });

  it("resolves to nothing when the user picked nothing", () => {
    // No fabricated default: the wire omits the field, so the session runs on
    // the harness's own configured default — which is not probeable.
    expect(resolveModel(claudeProviders, undefined, undefined)).toBeUndefined();
  });

  it("drops a pick the probe doesn't vouch for", () => {
    // The shape of "switched harness with a stale model in the URL": never
    // display or submit a pair that isn't in this harness's providers.
    expect(resolveModel(claudeProviders, "codex", "gpt-5.6-sol")).toBeUndefined();
  });

  it("treats the modelId as provider-scoped, not global", () => {
    // Same modelId under the wrong provider must not resolve — the pair is a
    // composite key, and half a match is no match.
    expect(resolveModel(claudeProviders, "codex", "sonnet")).toBeUndefined();
  });

  it("ignores a URL-supplied pick until the probe can vouch for it", () => {
    // Passing it through unchecked would send `session.create` a pair this
    // directory may not resolve at all; omitting it means "harness default".
    expect(resolveModel([], "claude-code", "sonnet")).toBeUndefined();
  });
});

describe("reasoningEffort cascades from the selected model", () => {
  const sol: ModelInfo = {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  };
  const mini: ModelInfo = { id: "gpt-5.6-mini", label: "GPT-5.6 Mini" };
  const codexProviders: ReadonlyArray<ProviderInfo> = [{ id: "codex", models: [sol, mini] }];

  it("reads the candidates off the resolved model", () => {
    const model = resolveModel(codexProviders, "codex", "gpt-5.6-sol");
    const modelInfo = findModelInfo(codexProviders, model?.providerId, model?.modelId);

    expect(modelInfo?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(resolveReasoningEffort(modelInfo, undefined)).toBe("medium");
  });

  it("keeps an explicit reasoningEffort that the model supports", () => {
    expect(resolveReasoningEffort(sol, "high")).toBe("high");
  });

  it("drops the reasoningEffort when the selected model has no reasoningEffort switch", () => {
    // Changing models must never carry a reasoningEffort onto a model that doesn't
    // offer it — the control disappears and create/set omit the field.
    const modelInfo = findModelInfo(codexProviders, "codex", "gpt-5.6-mini");

    expect(modelInfo?.reasoningEfforts).toBeUndefined();
    expect(resolveReasoningEffort(modelInfo, "high")).toBeUndefined();
  });

  it("falls back to the model default when the pick is outside its reasoningEfforts", () => {
    expect(resolveReasoningEffort(sol, "max")).toBe("medium");
  });

  it("resolves to nothing while the probe is still in flight", () => {
    expect(resolveReasoningEffort(undefined, "high")).toBeUndefined();
  });
});

describe("findModelInfo", () => {
  it("requires both halves of the pair to match", () => {
    expect(findModelInfo(claudeProviders, "claude-code", "sonnet")?.id).toBe("sonnet");
    expect(findModelInfo(claudeProviders, "codex", "sonnet")).toBeUndefined();
    expect(findModelInfo(claudeProviders, "claude-code", undefined)).toBeUndefined();
    expect(findModelInfo(claudeProviders, undefined, "sonnet")).toBeUndefined();
  });
});

describe("resolvePermissionMode", () => {
  it("preselects the harness's declared default", () => {
    expect(resolvePermissionMode(claudeCode, undefined)).toBe("full");
  });

  it("honours an explicit pick within the declared subset", () => {
    expect(resolvePermissionMode(claudeCode, "plan")).toBe("plan");
  });

  it("drops a pick outside the declared subset", () => {
    expect(resolvePermissionMode(claudeCode, "ask")).toBe("full");
  });

  it("resolves to nothing for a harness that declares nothing", () => {
    const pi: HarnessAgentInfo = { id: "pi", name: "Pi", available: true, permissionModes: [] };
    expect(resolvePermissionMode(pi, "full")).toBeUndefined();
  });

  it("resolves to nothing while the list has not landed", () => {
    expect(resolvePermissionMode(undefined, "full")).toBeUndefined();
  });

  it("orders the subset canonically for display, not as the harness declared it", () => {
    // The subset arrives unordered from the wire; presentation order is
    // client-owned and always the same across harnesses.
    expect(orderPermissionModes(["full", "plan"])).toEqual(["plan", "full"]);
  });
});

const harness = (id: HarnessAgentId, available: boolean): HarnessAgentInfo => ({
  id,
  name: id,
  available,
  permissionModes: [],
});

it("starts a draft on the preferred harness when it is installed", () => {
  expect(
    pickDefaultHarnessAgentId(
      [harness("claude-code", true), harness("codex", true)],
      "claude-code",
    ),
  ).toBe("claude-code");
});

it("falls through to the first available harness when the preferred one is missing", () => {
  expect(
    pickDefaultHarnessAgentId(
      [harness("claude-code", false), harness("codex", true)],
      "claude-code",
    ),
  ).toBe("codex");
});

it("keeps the preferred harness while the list has not landed", () => {
  expect(pickDefaultHarnessAgentId([], "claude-code")).toBe("claude-code");
});

it("keeps the preferred harness when nothing at all is installed", () => {
  expect(
    pickDefaultHarnessAgentId(
      [harness("claude-code", false), harness("codex", false)],
      "claude-code",
    ),
  ).toBe("claude-code");
});
