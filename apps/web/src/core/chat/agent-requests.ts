// Provider-agnostic agent requests (neo's Tier-1 shape): a request the agent
// raises that pauses its turn until the user answers, and the user's answer.
// Two interaction shapes collapse into three `type`s:
//   • decision — `tool` / `plan`: the user picks allow/deny
//   • question — the user supplies data (answers), not a yes/no
// The transcript renders these without knowing which agent raised them;
// provider mapping lives at the boundary (providers/claude-code/request.ts).

export type AgentRequestType = "tool" | "plan" | "question";

// A persistable permission grant carried on an allow-action.
export type AgentGrant = { type: "session" };

// An option on a decision-style (`tool`) request. The card renders `label`;
// `id` is echoed back as `selectedActionId`.
export type AgentRequestAction = {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  grant?: AgentGrant;
  variant?: "primary" | "secondary" | "danger";
};

// One selectable option on a `choice` question.
export type AgentRequestQuestionOption = {
  label: string;
  description?: string;
};

// One question in a `question` request. `kind` widens the input beyond a plain
// choice so free-text prompts are representable.
export type AgentRequestQuestion = {
  id: string;
  question: string;
  header?: string;
  kind?: "choice" | "freeText";
  options?: AgentRequestQuestionOption[];
  multiSelect?: boolean;
};

export type AgentRequest =
  | {
      type: "tool";
      id: string;
      toolName: string;
      input: unknown;
      actions: AgentRequestAction[];
      title?: string;
      description?: string;
    }
  | {
      type: "plan";
      id: string;
      plan: string;
    }
  | {
      type: "question";
      id: string;
      questions: AgentRequestQuestion[];
    };

// One answer in a `question` response, keyed back to its question.
export type AgentResponseAnswer = {
  questionId: string;
  values: string[];
  other?: string;
};

// Plan approval carries the permission mode the session should continue in.
// The mode names are Claude Code's; they stay here (not in `native`) because
// plan requests are only ever raised by claude-code today.
export type PlanApprovalMode = "default" | "acceptEdits" | "bypassPermissions";

// Discriminated by the SAME `type` as the request: `tool`/`plan` return a
// decision, `question` returns answers.
export type AgentResponse =
  | {
      type: "tool";
      selectedActionId: string;
      behavior: "allow" | "deny";
      grant?: AgentGrant;
      interrupt?: boolean;
    }
  | {
      type: "plan";
      behavior: "allow" | "deny";
      mode?: PlanApprovalMode;
      message?: string;
      interrupt?: boolean;
    }
  | { type: "question"; answers: AgentResponseAnswer[] };

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
