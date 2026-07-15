import type { AgentRequest, AgentRequestAction, AgentResponse } from "@vibest/contract";

export type {
  AgentGrant,
  AgentRequest,
  AgentRequestAction,
  AgentRequestQuestion,
  AgentResponse,
  AgentResponseAnswer,
  PlanApprovalMode,
} from "@vibest/contract";

export type AgentRequestType = AgentRequest["type"];

export function buildToolResponse(action: AgentRequestAction): AgentResponse {
  return {
    type: "tool",
    selectedActionId: action.id,
    behavior: action.behavior,
    grant: action.grant,
    interrupt: action.behavior === "deny" ? action.variant === "danger" : undefined,
  };
}
