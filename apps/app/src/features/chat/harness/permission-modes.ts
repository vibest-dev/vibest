import type { PermissionMode } from "@vibest/contract";

/**
 * The single place that knows how to present vibest's permission vocabulary.
 * The words are ours (harness-concept-ownership §3.1), so labels, descriptions,
 * ordering and the danger tone live client-side — the server only ever says
 * which members a harness supports.
 */
export const PERMISSION_MODES: Record<
  PermissionMode,
  { readonly label: string; readonly description: string; readonly tone?: "danger" }
> = {
  plan: {
    label: "Plan",
    description: "Propose a plan and wait for approval before acting",
  },
  "read-only": {
    label: "Read only",
    description: "Read the workspace; never write files or run commands",
  },
  ask: {
    label: "Ask",
    description: "Ask before file edits and commands",
  },
  acceptEdits: {
    label: "Accept edits",
    description: "Auto-approve file edits; still ask before commands",
  },
  full: {
    label: "Full access",
    description: "Run without approval prompts",
    tone: "danger",
  },
};

// Canonical display order — safest first. The server declares an unordered
// subset; presentation order is a client decision.
export const PERMISSION_MODE_ORDER: ReadonlyArray<PermissionMode> = [
  "plan",
  "read-only",
  "ask",
  "acceptEdits",
  "full",
];

/** A harness's declared subset, in canonical display order. */
export const orderPermissionModes = (
  modes: ReadonlyArray<PermissionMode>,
): ReadonlyArray<PermissionMode> => PERMISSION_MODE_ORDER.filter((mode) => modes.includes(mode));
