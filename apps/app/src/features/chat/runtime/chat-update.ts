import type { PromptPart } from "@vibest/contract";
import type { ChatStatus, UIMessage } from "ai";

import type { AgentRequest } from "./agent-requests";
import type { ChatState, OutgoingMessage } from "./chat-state";

export type ChatAction =
  | {
      type: "messageQueued";
      message: UIMessage;
      parts: ReadonlyArray<PromptPart>;
    }
  | { type: "messageSubmissionStarted"; messageId: string }
  | { type: "messageSubmissionFinished"; messageId: string }
  | { type: "messageSubmissionFailed"; messageId: string; error: Error }
  | { type: "userMessageReceived"; message: UIMessage }
  | { type: "userMessageRejected"; messageId: string }
  | { type: "assistantMessageUpdated"; message: UIMessage }
  | {
      type: "historyReadFinished";
      history: ReadonlyArray<UIMessage> | null;
      replaceMessages: boolean;
    }
  | { type: "historyReadFailed" }
  | { type: "statusChanged"; status: ChatStatus }
  | { type: "errorChanged"; error: Error | undefined }
  | { type: "pendingRequestsReplaced"; requests: AgentRequest[] }
  | { type: "requestAdded"; request: AgentRequest }
  | { type: "requestRemoved"; requestId: string }
  | { type: "requestsCleared" }
  | { type: "sessionTerminated"; error: Error }
  | { type: "chatDisposed" };

const snapshotMessage = (message: UIMessage): UIMessage => structuredClone(message);

type ActiveChatAction = Exclude<ChatAction, { type: "chatDisposed" }>;

function updateActiveChat(state: ChatState, action: ActiveChatAction): ChatState {
  switch (action.type) {
    case "messageQueued":
      return {
        ...state,
        outgoing: [
          ...state.outgoing,
          { message: action.message, parts: action.parts, status: "queued" },
        ],
      };
    case "messageSubmissionStarted": {
      const outgoing = state.outgoing.map((message) =>
        message.message.id === action.messageId
          ? { ...message, status: "sending" as const }
          : message,
      );
      const submitted = outgoing.find((message) => message.message.id === action.messageId);
      if (!submitted) return state;
      const messages = state.session.messages.some((message) => message.id === action.messageId)
        ? state.session.messages
        : [...state.session.messages, submitted.message];
      return {
        ...state,
        session: { ...state.session, messages },
        outgoing,
        status: "submitted",
        error: undefined,
      };
    }
    case "messageSubmissionFinished":
      return {
        ...state,
        outgoing: state.outgoing.filter((message) => message.message.id !== action.messageId),
      };
    case "messageSubmissionFailed":
      return {
        ...state,
        outgoing: state.outgoing.filter((message) => message.message.id !== action.messageId),
        status: "error",
        error: action.error,
      };
    case "userMessageReceived":
      if (state.session.messages.some((message) => message.id === action.message.id)) return state;
      return {
        ...state,
        session: {
          ...state.session,
          messages: [...state.session.messages, action.message],
        },
        error: undefined,
      };
    case "userMessageRejected":
      return {
        ...state,
        session: {
          ...state.session,
          messages: state.session.messages.filter((message) => message.id !== action.messageId),
        },
      };
    case "assistantMessageUpdated": {
      const index = state.session.messages.findIndex((message) => message.id === action.message.id);
      const messages = state.session.messages.slice();
      if (index === -1) messages.push(snapshotMessage(action.message));
      else messages[index] = snapshotMessage(action.message);
      return { ...state, session: { ...state.session, messages } };
    }
    case "historyReadFinished":
      return {
        ...state,
        session: {
          ...state.session,
          messages:
            action.replaceMessages && action.history !== null && action.history.length > 0
              ? Array.from(action.history)
              : state.session.messages,
          historyStatus: action.history === null ? "unavailable" : "settled",
        },
      };
    case "historyReadFailed":
      return {
        ...state,
        session: { ...state.session, historyStatus: "unavailable" },
      };
    case "statusChanged":
      return state.status === action.status ? state : { ...state, status: action.status };
    case "errorChanged":
      return { ...state, error: action.error };
    case "pendingRequestsReplaced":
      return {
        ...state,
        session: { ...state.session, pendingRequests: Array.from(action.requests) },
      };
    case "requestAdded": {
      const existing = state.session.pendingRequests.findIndex(
        (request) => request.id === action.request.id,
      );
      const pendingRequests = state.session.pendingRequests.slice();
      if (existing === -1) pendingRequests.push(action.request);
      else pendingRequests[existing] = action.request;
      return { ...state, session: { ...state.session, pendingRequests } };
    }
    case "requestRemoved":
      return {
        ...state,
        session: {
          ...state.session,
          pendingRequests: state.session.pendingRequests.filter(
            (request) => request.id !== action.requestId,
          ),
        },
      };
    case "requestsCleared":
      return {
        ...state,
        session: { ...state.session, pendingRequests: [] },
      };
    case "sessionTerminated":
      return {
        ...state,
        lifecycle: { ...state.lifecycle, session: "terminated" },
        outgoing: [],
        session: {
          ...state.session,
          pendingRequests: [],
          historyStatus: "settled",
        },
        status: "error",
        error: action.error,
      };
  }
}

export function isChatActive(state: ChatState): boolean {
  return state.lifecycle.session === "available" && state.lifecycle.instance === "active";
}

export function updateChat(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "chatDisposed") {
    return state.lifecycle.instance === "disposed"
      ? state
      : {
          ...state,
          lifecycle: { ...state.lifecycle, instance: "disposed" },
          outgoing: [],
        };
  }
  if (!isChatActive(state)) return state;
  return updateActiveChat(state, action);
}

export function firstQueuedMessage(state: ChatState): OutgoingMessage | undefined {
  return state.outgoing.find((message) => message.status === "queued");
}

export function sendingMessage(state: ChatState): OutgoingMessage | undefined {
  return state.outgoing.find((message) => message.status === "sending");
}

export function hasSendingMessage(state: ChatState): boolean {
  return sendingMessage(state) !== undefined;
}

export function hasMessage(state: ChatState, messageId: string): boolean {
  return state.session.messages.some((message) => message.id === messageId);
}
