import type {
  PromptPart,
  SessionPhase,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
} from "@vibest/contract";
import type { ChatStatus, UIMessage } from "ai";

import type { AgentRequest, AgentResponse } from "./agent-requests";

export type HistoryStatus = "loading" | "settled" | "unavailable";

export type OutgoingMessage = {
  readonly message: UIMessage;
  readonly parts: ReadonlyArray<PromptPart>;
  readonly status: "queued" | "sending";
};

export type TurnFoldState = {
  readonly generation: number;
  readonly status: "open" | "closing";
};

export type HistoryReadState = {
  readonly id: number;
  readonly promptRevision: number;
};

export type HistoryFloorState = {
  readonly id: number;
  readonly snapshot: SessionRuntimeSnapshot;
  readonly events: ReadonlyArray<SessionScopedEvent>;
};

export type PendingResponse = {
  readonly request: AgentRequest | undefined;
  readonly restoreOnFailure: boolean;
  readonly response: AgentResponse;
};

export type ChatState = {
  session: {
    messages: UIMessage[];
    pendingRequests: AgentRequest[];
    historyStatus: HistoryStatus;
    status: ChatStatus;
    error: Error | undefined;
  };
  outgoing: OutgoingMessage[];
  lifecycle: {
    session: "available" | "terminated";
    instance: "active" | "disposed";
  };
  sync: {
    cursor: number;
    historyLoaded: boolean;
    floor: HistoryFloorState | null;
    reconcile: HistoryReadState | null;
    needsReconcile: boolean;
  };
  prompt: {
    revision: number;
    deferredPhase: SessionPhase | null;
    boundaryOpen: boolean;
    pendingMessageIds: string[];
    lastEndedTurnId: string | null;
  };
  turns: {
    folds: Record<string, TurnFoldState>;
    recoverTurnIds: string[];
    erroredTurnIds: string[];
    nextGeneration: number;
  };
  pendingResponses: Record<string, PendingResponse>;
  nextOperationId: number;
};

export function createChatState(): ChatState {
  return {
    session: {
      messages: [],
      pendingRequests: [],
      historyStatus: "loading",
      status: "ready",
      error: undefined,
    },
    outgoing: [],
    lifecycle: { session: "available", instance: "active" },
    sync: {
      cursor: 0,
      historyLoaded: false,
      floor: null,
      reconcile: null,
      needsReconcile: false,
    },
    prompt: {
      revision: 0,
      deferredPhase: null,
      boundaryOpen: false,
      pendingMessageIds: [],
      lastEndedTurnId: null,
    },
    turns: {
      folds: {},
      recoverTurnIds: [],
      erroredTurnIds: [],
      nextGeneration: 1,
    },
    pendingResponses: {},
    nextOperationId: 1,
  };
}
