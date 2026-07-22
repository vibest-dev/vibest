import type { HarnessAgentId, HarnessAgentInfo, HarnessAgentCatalog } from "@vibest/contract";

/**
 * Which harness a fresh draft starts on.
 *
 * `preferred` is the product's opinion, but it only wins if it is actually
 * usable: landing a machine that only installed Codex on a disabled Claude Code
 * means the very first Enter fails on a harness whose CLI isn't there. Falling
 * through to the first available one costs nothing and is right far more often
 * than it is wrong. Before negotiation lands the list is empty and `preferred`
 * stands — the picker has nothing better to offer yet either.
 */
export function pickDefaultHarnessAgentId(
  harnessAgents: ReadonlyArray<HarnessAgentInfo>,
  preferred: HarnessAgentId,
): HarnessAgentId {
  if (harnessAgents.some((harnessAgent) => harnessAgent.id === preferred && harnessAgent.available))
    return preferred;
  return harnessAgents.find((harnessAgent) => harnessAgent.available)?.id ?? preferred;
}

/**
 * Turning a harness's two halves — the static capabilities from `negotiate` and
 * the per-directory catalog from `catalog` — plus whatever the user explicitly
 * picked, into the config the session controls render.
 *
 * Two rules, and both exist to keep the UI from ever showing a value the
 * harness doesn't offer:
 *
 * - A dimension nothing declared has no options and no value, so the control
 *   isn't rendered at all and `session.create` omits the field — which is how
 *   the harness ends up using its own configured default. A catalog that simply
 *   hasn't arrived yet lands here too, and that is deliberate: the user can
 *   submit before it does, and gets the harness's default rather than a wait.
 * - A selection that isn't in the harness's list is ignored, not passed
 *   through. That happens for real: switch harness with `?model=` still in the
 *   URL, or open a codex session while the client still remembers a claude
 *   model id.
 */

export type SessionConfigSelection = {
  readonly model?: string;
  readonly permissionMode?: string;
};

export type SessionConfigOption = {
  readonly id: string;
  readonly label: string;
};

export type ResolvedSessionConfig = {
  readonly models: ReadonlyArray<SessionConfigOption>;
  readonly model?: string;
  readonly permissionModes: ReadonlyArray<SessionConfigOption>;
  readonly permissionMode?: string;
};

const resolve = (
  options: ReadonlyArray<SessionConfigOption>,
  selected: string | undefined,
  fallback: string | undefined,
): string | undefined => {
  const has = (id: string | undefined) => id !== undefined && options.some((o) => o.id === id);
  if (has(selected)) return selected;
  return has(fallback) ? fallback : undefined;
};

export function resolveSessionConfig(
  harnessAgent: HarnessAgentInfo | undefined,
  catalog: HarnessAgentCatalog | undefined,
  selection: SessionConfigSelection = {},
): ResolvedSessionConfig {
  const capabilities = harnessAgent?.capabilities;
  const models: ReadonlyArray<SessionConfigOption> = (catalog?.models ?? []).map((model) => ({
    id: model.id,
    label: model.name ?? model.id,
  }));
  const permissionModes: ReadonlyArray<SessionConfigOption> = (
    capabilities?.permissionModes ?? []
  ).map((mode) => ({ id: mode.id, label: mode.label }));

  return {
    models,
    permissionModes,
    ...withKey("model", resolve(models, selection.model, catalog?.defaultModel)),
    ...withKey(
      "permissionMode",
      resolve(permissionModes, selection.permissionMode, capabilities?.defaultPermissionMode),
    ),
  };
}

const withKey = <K extends string>(key: K, value: string | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, string>);
