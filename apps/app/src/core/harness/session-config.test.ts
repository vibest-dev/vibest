import type { HarnessAgentCatalog, HarnessAgentId, HarnessAgentInfo } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { pickDefaultHarnessAgentId, resolveSessionConfig } from "./session-config";

const claudeCode: HarnessAgentInfo = {
  id: "claude-code",
  name: "Claude Code",
  available: true,
  capabilities: {
    permissionModes: [
      { id: "plan", label: "Plan" },
      { id: "full", label: "Full access" },
    ],
    defaultPermissionMode: "full",
  },
};

// The other half, probed per directory rather than negotiated once.
const claudeCatalog: HarnessAgentCatalog = {
  models: [
    { id: "default", name: "Default (recommended)" },
    { id: "sonnet", name: "Sonnet" },
  ],
  defaultModel: "default",
};

const pi: HarnessAgentInfo = { id: "pi", name: "Pi", available: true, capabilities: {} };

describe("resolveSessionConfig", () => {
  it("preselects the harness's declared defaults", () => {
    const config = resolveSessionConfig(claudeCode, claudeCatalog);

    expect(config.model).toBe("default");
    expect(config.permissionMode).toBe("full");
    expect(config.models.map((m) => m.id)).toEqual(["default", "sonnet"]);
  });

  it("honours an explicit selection over the default", () => {
    const config = resolveSessionConfig(claudeCode, claudeCatalog, {
      model: "sonnet",
      permissionMode: "plan",
    });

    expect(config.model).toBe("sonnet");
    expect(config.permissionMode).toBe("plan");
  });

  it("drops a selection the harness doesn't offer", () => {
    // The shape of "switched harness with a stale ?model= in the URL": the
    // control must fall back to this harness's default, never display an id
    // that isn't in its list.
    const config = resolveSessionConfig(claudeCode, claudeCatalog, { model: "gpt-5.6-sol" });

    expect(config.model).toBe("default");
  });

  it("offers nothing for a harness that declares no capabilities", () => {
    const config = resolveSessionConfig(pi, {}, { model: "sonnet", permissionMode: "full" });

    expect(config.models).toEqual([]);
    expect(config.permissionModes).toEqual([]);
    // Undefined, not empty string: create must omit the field entirely so pi
    // keeps its own defaults.
    expect(config.model).toBeUndefined();
    expect(config.permissionMode).toBeUndefined();
  });

  it("skips a declared default that isn't in the list", () => {
    const config = resolveSessionConfig(claudeCode, { ...claudeCatalog, defaultModel: "opus" });

    expect(config.model).toBeUndefined();
  });

  it("resolves to nothing while negotiation is still in flight", () => {
    expect(resolveSessionConfig(undefined, undefined)).toEqual({ models: [], permissionModes: [] });
  });

  it("falls back to the model id when the harness gave no display name", () => {
    const config = resolveSessionConfig(claudeCode, { models: [{ id: "sonnet" }] });

    expect(config.models).toEqual([{ id: "sonnet", label: "sonnet" }]);
  });
});

const harness = (id: HarnessAgentId, available: boolean): HarnessAgentInfo => ({
  id,
  name: id,
  available,
  capabilities: {},
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

it("keeps the preferred harness while negotiation has not landed", () => {
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

describe("resolveSessionConfig while the catalog is still in flight", () => {
  it("offers no models but keeps the permission modes", () => {
    // The negotiation lands first and never fails; the catalog costs a CLI
    // spawn and arrives later. The permission picker must not wait on it.
    const config = resolveSessionConfig(claudeCode, undefined);

    expect(config.models).toEqual([]);
    expect(config.model).toBeUndefined();
    expect(config.permissionModes.map((mode) => mode.id)).toEqual(["plan", "full"]);
    expect(config.permissionMode).toBe("full");
  });

  it("ignores a URL-supplied model until the catalog can vouch for it", () => {
    // Passing it through unchecked would send `session.create` an id this
    // directory may not resolve at all; omitting it means "harness default",
    // which is both safe and what the picker is showing.
    const config = resolveSessionConfig(claudeCode, undefined, { model: "sonnet" });

    expect(config.model).toBeUndefined();
  });
});
