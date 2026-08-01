import type {
  HarnessAgentId,
  HarnessAgentInfo,
  ModelInfo,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
} from "@vibest/contract";

/**
 * Which harness a fresh draft starts on.
 *
 * `preferred` is the product's opinion, but it only wins if it is actually
 * usable: landing a machine that only installed Codex on a disabled Claude Code
 * means the very first Enter fails on a harness whose CLI isn't there. Falling
 * through to the first available one costs nothing and is right far more often
 * than it is wrong. Before the list lands it is empty and `preferred` stands —
 * the picker has nothing better to offer yet either.
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
 * Each session-config dimension resolves on its own — their option sources are
 * different endpoints (permission modes are declared by `harness.list`, the
 * model catalog is probed by `harness.probe`, reasoningEffort candidates are read off
 * the resolved model), so there is no combined "config" object to name. What
 * the resolvers share is one rule: a pick that isn't offered is dropped, never
 * passed through, and an absent pick falls back to the declared default. Stale
 * picks happen for real — switch harness with a model still in the URL, or
 * hold a claude pair while opening a codex session.
 *
 * A dimension nothing declared has no options and no value, so its control
 * isn't rendered and `session.create` omits the field — which is how the
 * harness ends up using its own configured default. A probe that simply hasn't
 * arrived yet lands there too, and that is deliberate: the user can submit
 * before it does, and gets the harness's default rather than a wait.
 */

/** The traits behind a providerId/modelId pair — undefined when the pair is
 * absent or points outside the probed catalog. Both halves must match: a
 * modelId is only unique within its provider. */
export const findModelInfo = (
  providers: ReadonlyArray<ProviderInfo>,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelInfo | undefined =>
  providers
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.id === modelId);

/** The picked pair while the catalog still offers it, else nothing. There is
 * deliberately no default to fall back to: a catalog's "default" marker is the
 * provider's suggestion, not what an unconfigured session actually runs — the
 * harness's own user config decides that, and it is not probeable. No pick →
 * the control shows its placeholder and the wire omits the field, so the
 * harness decides. */
export const resolveModel = (
  providers: ReadonlyArray<ProviderInfo>,
  providerId: string | undefined,
  modelId: string | undefined,
): { providerId: string; modelId: string } | undefined =>
  providerId !== undefined &&
  modelId !== undefined &&
  findModelInfo(providers, providerId, modelId) !== undefined
    ? { providerId, modelId }
    : undefined;

/** The picked reasoningEffort while the model supports it, else that model's default.
 * The candidates live on the model (`modelInfo.reasoningEfforts`) — reasoningEffort cascades
 * from the model selection, it has no harness-level domain. */
export const resolveReasoningEffort = (
  modelInfo: ModelInfo | undefined,
  reasoningEffort: ReasoningEffort | undefined,
): ReasoningEffort | undefined =>
  reasoningEffort !== undefined && (modelInfo?.reasoningEfforts ?? []).includes(reasoningEffort)
    ? reasoningEffort
    : modelInfo?.defaultReasoningEffort;

/** The picked mode while the harness declares it, else the declared default —
 * validated against the subset too, so a harness bug can't surface a value the
 * control doesn't offer. */
export const resolvePermissionMode = (
  harnessAgent: HarnessAgentInfo | undefined,
  permissionMode: PermissionMode | undefined,
): PermissionMode | undefined => {
  const declared = harnessAgent?.permissionModes ?? [];
  if (permissionMode !== undefined && declared.includes(permissionMode)) return permissionMode;
  return harnessAgent?.defaultPermissionMode !== undefined &&
    declared.includes(harnessAgent.defaultPermissionMode)
    ? harnessAgent.defaultPermissionMode
    : undefined;
};
