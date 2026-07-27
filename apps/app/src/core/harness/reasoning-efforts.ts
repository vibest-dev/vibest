import type { ReasoningEffort } from "@vibest/contract";

/**
 * Display knowledge for the reasoning-reasoningEffort union. Like permission modes,
 * reasoningEffort names are vibest's vocabulary — adapters translate native levels into
 * it — so their labels and ordering are client-owned. Which members a given
 * model offers comes from that model's probed traits (`ModelInfo.reasoningEfforts`).
 */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// Canonical display order — cheapest first.
export const REASONING_EFFORT_ORDER: ReadonlyArray<ReasoningEffort> = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model's declared reasoningEfforts, in canonical display order. */
export const orderReasoningEfforts = (
  reasoningEfforts: ReadonlyArray<ReasoningEffort>,
): ReadonlyArray<ReasoningEffort> =>
  REASONING_EFFORT_ORDER.filter((reasoningEffort) => reasoningEfforts.includes(reasoningEffort));
