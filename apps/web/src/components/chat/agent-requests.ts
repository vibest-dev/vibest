// Provider-agnostic agent requests (neo's Tier-1 shape): the transcript renders
// these without knowing which agent raised them. Provider mapping lives at the
// boundary (claude-code-requests.ts). Only `tool` exists today; the
// discriminated `type` keeps question/plan addable without touching the UI.

// A persistable permission grant carried on an allow-action.
export type AgentGrant = { type: "session" };

// An option on a decision-style request. The card renders `label`; `id` is
// echoed back as `selectedActionId`.
export type AgentRequestAction = {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  grant?: AgentGrant;
  variant?: "primary" | "secondary" | "danger";
};

export type AgentRequest = {
  type: "tool";
  id: string;
  toolName: string;
  input: unknown;
  actions: AgentRequestAction[];
  title?: string;
  description?: string;
};

export type AgentResponse = {
  type: "tool";
  selectedActionId: string;
  behavior: "allow" | "deny";
  grant?: AgentGrant;
  interrupt?: boolean;
};

// Pure: maps a clicked action to the response the provider boundary consumes.
// interrupt:true = hard interrupt (danger deny); a plain deny lets the turn
// continue without the tool.
export function buildToolResponse(action: AgentRequestAction): AgentResponse {
  return {
    type: "tool",
    selectedActionId: action.id,
    behavior: action.behavior,
    grant: action.grant,
    interrupt: action.behavior === "deny" ? action.variant === "danger" : undefined,
  };
}
