import type { ToolPermissionRequest } from "@vibest/contract/claude-code";

import type {
  AgentRequest,
  AgentRequestAction,
  AgentRequestQuestion,
  AgentRequestQuestionOption,
  AgentResponse,
} from "../../agent-requests";

export type PermissionUpdate = NonNullable<ToolPermissionRequest["suggestions"]>[number];

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

// The claude-code boundary: wire permission events become provider-free
// AgentRequests here (routed by tool name — ExitPlanMode is a plan approval,
// AskUserQuestion is a question, everything else a tool decision), and
// responses map back to the SDK's PermissionResult. Provider detail
// (suggestions, original input) never enters the React tree.

// ExitPlanMode with an empty/whitespace plan is auto-allowed with no dialog.
export function isAutoAllowed(event: ToolPermissionRequest): boolean {
  return (
    event.toolName === "ExitPlanMode" &&
    !String((event.input as { plan?: unknown })?.plan ?? "").trim()
  );
}

export function toAgentRequest(event: ToolPermissionRequest): AgentRequest {
  if (event.toolName === "AskUserQuestion") return toQuestionRequest(event);
  if (event.toolName === "ExitPlanMode") return toPlanRequest(event);
  return toToolRequest(event);
}

function toToolRequest(event: ToolPermissionRequest): AgentRequest {
  const actions: AgentRequestAction[] = [
    { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
    ...(event.suggestions?.length
      ? [
          {
            id: "grant:session",
            label: "Allow for this session",
            behavior: "allow",
            grant: { type: "session" },
          } satisfies AgentRequestAction,
        ]
      : []),
    { id: "deny", label: "Deny", behavior: "deny" },
  ];
  return {
    type: "tool",
    id: event.requestId,
    toolName: event.toolName,
    input: event.input,
    actions,
  };
}

function toPlanRequest(event: ToolPermissionRequest): AgentRequest {
  return {
    type: "plan",
    id: event.requestId,
    plan: String((event.input as { plan?: unknown })?.plan ?? ""),
  };
}

// The question TEXT is used as the question `id` so answers can round-trip
// back keyed by text (the SDK reads `updatedInput.answers` keyed that way).
function toQuestionRequest(event: ToolPermissionRequest): AgentRequest {
  const input = event.input as { questions?: unknown };
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const questions: AgentRequestQuestion[] = rawQuestions.map((raw: Record<string, unknown>) => {
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const question: AgentRequestQuestion = {
      id: String(raw.question),
      question: String(raw.question),
      kind: rawOptions.length > 0 ? "choice" : "freeText",
    };
    if (raw.header != null) question.header = String(raw.header);
    if (typeof raw.multiSelect === "boolean") question.multiSelect = raw.multiSelect;
    if (rawOptions.length > 0) {
      question.options = rawOptions.map(
        (o: Record<string, unknown>): AgentRequestQuestionOption => ({
          label: String(o.label),
          ...(o.description != null ? { description: String(o.description) } : {}),
        }),
      );
    }
    return question;
  });
  return { type: "question", id: event.requestId, questions };
}

export function toPermissionResult(
  event: ToolPermissionRequest,
  response: AgentResponse,
): PermissionResult {
  if (response.type === "question") {
    // AskUserQuestion: answers keyed by question text (the round-trip id).
    if (response.answers.length === 0) return { behavior: "deny", message: "Dismissed" };
    const answers: Record<string, string> = {};
    for (const answer of response.answers) {
      const parts = [...answer.values];
      if (answer.other) parts.push(answer.other);
      answers[answer.questionId] = parts.join(", ");
    }
    return { behavior: "allow", updatedInput: { ...event.input, answers } };
  }

  if (response.behavior === "allow") {
    const result: PermissionResult = { behavior: "allow", updatedInput: event.input };
    if (response.type === "plan" && response.mode) {
      // Plan approval re-enters the chosen permission mode for the session.
      result.updatedPermissions = [
        { type: "setMode", mode: response.mode, destination: "session" },
      ];
    }
    // A session grant re-scopes the SDK's suggested permission rules to this
    // session and rides back on the allow.
    if (
      response.type === "tool" &&
      response.grant?.type === "session" &&
      event.suggestions?.length
    ) {
      result.updatedPermissions = event.suggestions.map((s) =>
        "destination" in s ? { ...s, destination: "session" as const } : s,
      );
    }
    return result;
  }

  const feedback = response.type === "plan" ? response.message?.trim() : undefined;
  return {
    behavior: "deny",
    message: feedback || "User denied the permission request",
    interrupt: response.interrupt,
  };
}
