import type {
  AgentRequest,
  AgentRequestQuestion,
  AgentResponse,
  AgentResponseAnswer,
} from "../types/request";
import type { PiUiRequest, RpcExtensionUIResponse } from "./protocol";

// Maps pi's blocking extension-UI requests onto our provider-agnostic
// AgentRequest/AgentResponse round-trip (the pi analog of codex/request.ts).
// Pi has no native tool-approval protocol — approvals arrive as whatever an
// extension asks via ctx.ui.confirm/select/input/editor — so every request maps
// to the `question` arm, with the raw wire request on `native`. The reply owed
// on stdin is reconstructed by `mapUiResponse`.

export const CONFIRM_YES = "Yes";
export const CONFIRM_NO = "No";

type PiQuestionRequest = Extract<AgentRequest, { type: "question" }>;

function toQuestion(request: PiUiRequest): AgentRequestQuestion {
  switch (request.method) {
    case "confirm":
      return {
        id: request.id,
        question: request.message,
        header: request.title,
        kind: "choice",
        options: [{ label: CONFIRM_YES }, { label: CONFIRM_NO }],
      };
    case "select":
      return {
        id: request.id,
        question: request.title,
        kind: "choice",
        options: request.options.map((label) => ({ label })),
      };
    case "input":
    case "editor":
      return { id: request.id, question: request.title, kind: "freeText" };
  }
}

/** Build a `question` AgentRequest (pi arm) from a blocking extension-UI request. */
export function buildUiRequest(request: PiUiRequest): PiQuestionRequest {
  return {
    harnessAgentId: "pi",
    type: "question",
    id: request.id,
    questions: [toQuestion(request)],
    native: request,
  };
}

function answerFor(response: AgentResponse, questionId: string): AgentResponseAnswer | undefined {
  if (response.type !== "question") return undefined;
  return response.answers.find((answer) => answer.questionId === questionId) ?? response.answers[0];
}

/** Reconstruct the extension_ui_response owed on stdin for a blocking request. */
export function mapUiResponse(
  request: PiUiRequest,
  response: AgentResponse,
): RpcExtensionUIResponse {
  const answer = answerFor(response, request.id);
  switch (request.method) {
    case "confirm":
      return {
        type: "extension_ui_response",
        id: request.id,
        confirmed: answer?.values[0] === CONFIRM_YES,
      };
    case "select": {
      const value = answer?.values[0];
      return value !== undefined
        ? { type: "extension_ui_response", id: request.id, value }
        : declineUiResponse(request);
    }
    case "input":
    case "editor": {
      const value = answer?.other ?? answer?.values[0];
      return value !== undefined
        ? { type: "extension_ui_response", id: request.id, value }
        : declineUiResponse(request);
    }
  }
}

/** The decline / no-consumer reply for a request kind. */
export function declineUiResponse(request: PiUiRequest): RpcExtensionUIResponse {
  return request.method === "confirm"
    ? { type: "extension_ui_response", id: request.id, confirmed: false }
    : { type: "extension_ui_response", id: request.id, cancelled: true };
}
