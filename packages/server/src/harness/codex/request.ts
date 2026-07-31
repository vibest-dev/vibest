import type {
  AgentRequest,
  AgentRequestAction,
  AgentRequestQuestion,
  AgentResponse,
} from "@vibest/contract";
import type { ServerRequest } from "@vibest/contract/codex/protocol";
import type { ToolRequestUserInputResponse } from "@vibest/contract/codex/protocol/v2";
import { v7 as uuid } from "uuid";

// Maps codex server→client requests onto our provider-agnostic
// AgentRequest/AgentResponse round-trip (the codex analog of claude-code/request.ts).
//   • Approvals (three methods) → `tool` AgentRequest; codex-native detail on `native`.
//   • requestUserInput            → `question` AgentRequest; no CodexRequestNative arm.
// The reply owed to the app-server is reconstructed by `mapApprovalResponse` /
// `mapUserInputResponse`.

export type ApprovalSource = "commandExecution" | "fileChange" | "permissions";

const APPROVAL_METHODS = {
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
} as const;

export type ApprovalServerRequest = Extract<
  ServerRequest,
  { method: keyof typeof APPROVAL_METHODS }
>;

export function isApprovalRequest(request: ServerRequest): request is ApprovalServerRequest {
  return request.method in APPROVAL_METHODS;
}

export function approvalSourceOf(method: ApprovalServerRequest["method"]): ApprovalSource {
  return APPROVAL_METHODS[method];
}

const APPROVAL_ACTIONS: AgentRequestAction[] = [
  { id: "accept", label: "Allow", behavior: "allow", variant: "primary" },
  { id: "decline", label: "Deny", behavior: "deny" },
];

type CodexToolRequest = Extract<AgentRequest, { type: "tool" }>;

/** Build a `tool` AgentRequest (codex arm) from a codex approval server-request. */
export function buildApprovalRequest(request: ApprovalServerRequest): CodexToolRequest {
  const base = {
    harnessAgentId: "codex",
    type: "tool",
    id: uuid(),
    actions: APPROVAL_ACTIONS,
  } as const;

  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const params = request.params;
      return {
        ...base,
        toolName: "commandExecution",
        input: { command: params.command, cwd: params.cwd, commandActions: params.commandActions },
        native: {
          source: "commandExecution",
          reason: params.reason ?? undefined,
          proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? undefined,
          proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments ?? undefined,
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const params = request.params;
      return {
        ...base,
        toolName: "fileChange",
        input: { grantRoot: params.grantRoot },
        native: {
          source: "fileChange",
          reason: params.reason ?? undefined,
          grantRoot: params.grantRoot ?? undefined,
        },
      };
    }
    case "item/permissions/requestApproval": {
      const params = request.params;
      return {
        ...base,
        toolName: "permissions",
        input: { cwd: params.cwd, permissions: params.permissions },
        native: { source: "permissions", profile: params.permissions },
      };
    }
  }
}

function deriveDecision(response: AgentResponse): "accept" | "decline" {
  return response.type === "tool" && response.behavior === "allow" ? "accept" : "decline";
}

/**
 * Reconstruct the app-server JSON-RPC result owed for an approval. A precise
 * codex decision on `native` wins; otherwise it's derived from the common
 * allow/deny.
 */
export function mapApprovalResponse(response: AgentResponse, source: ApprovalSource): unknown {
  // v1 limitation: permissions approvals are always answered with an empty
  // turn-scoped grant, regardless of allow/deny — granting real permissions is
  // deferred until the richer approval UI lands (it would carry the grant
  // payload via `native`).
  if (source === "permissions") return { permissions: {}, scope: "turn" };
  const native =
    response.type === "tool" ? (response.native as { decision?: string } | undefined) : undefined;
  return { decision: native?.decision ?? deriveDecision(response) };
}

/** The "deny" reply for a kind, used when the session is closed / has no consumer. */
export function declineResult(source: ApprovalSource): unknown {
  return source === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "decline" };
}

// ── requestUserInput → `question` AgentRequest ──────────────────────────────

export type UserInputServerRequest = Extract<
  ServerRequest,
  { method: "item/tool/requestUserInput" }
>;

export function isUserInputRequest(request: ServerRequest): request is UserInputServerRequest {
  return request.method === "item/tool/requestUserInput";
}

type CodexQuestionRequest = Extract<AgentRequest, { type: "question" }>;

/** Build a `question` AgentRequest from a codex requestUserInput server-request. */
export function buildUserInputRequest(request: UserInputServerRequest): CodexQuestionRequest {
  const questions: AgentRequestQuestion[] = request.params.questions.map((q) => ({
    id: q.id,
    question: q.question,
    ...(q.options
      ? {
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
        }
      : {}),
  }));
  return {
    harnessAgentId: "codex",
    type: "question",
    id: uuid(),
    questions,
    native: request.params,
  };
}

/** Map a `question` AgentResponse back to the app-server ToolRequestUserInputResponse. */
export function mapUserInputResponse(response: AgentResponse): ToolRequestUserInputResponse {
  if (response.type !== "question") return { answers: {} };
  return {
    answers: Object.fromEntries(
      response.answers.map((a) => {
        const values = a.other ? [...a.values, a.other] : [...a.values];
        return [a.questionId, { answers: values }];
      }),
    ),
  };
}

/** The decline / no-consumer reply for a requestUserInput. */
export function emptyUserInputResponse(): ToolRequestUserInputResponse {
  return { answers: {} };
}
