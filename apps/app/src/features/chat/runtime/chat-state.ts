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
  readonly delivery: "follow-up" | "steer";
  readonly status: "queued" | "sending" | "failed";
  readonly expectedTurnId?: string;
  readonly error?: Error;
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
    activeTurnId: string | null;
  };
  outgoing: OutgoingMessage[];
  lifecycle: {
    session: "available" | "terminated";
    instance: "active" | "disposed";
  };
  sync: {
    streamId: string | null;
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
      activeTurnId: null,
    },
    outgoing: [],
    lifecycle: { session: "available", instance: "active" },
    sync: {
      streamId: null,
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

export function copyChatState(state: ChatState): ChatState {
  return {
    ...state,
    session: {
      ...state.session,
      messages: state.session.messages.slice(),
      pendingRequests: state.session.pendingRequests.slice(),
    },
    outgoing: state.outgoing.slice(),
    lifecycle: { ...state.lifecycle },
    sync: {
      ...state.sync,
      floor: state.sync.floor
        ? { ...state.sync.floor, events: state.sync.floor.events.slice() }
        : null,
      reconcile: state.sync.reconcile ? { ...state.sync.reconcile } : null,
    },
    prompt: {
      ...state.prompt,
      pendingMessageIds: state.prompt.pendingMessageIds.slice(),
    },
    turns: {
      ...state.turns,
      folds: { ...state.turns.folds },
      recoverTurnIds: state.turns.recoverTurnIds.slice(),
      erroredTurnIds: state.turns.erroredTurnIds.slice(),
    },
    pendingResponses: { ...state.pendingResponses },
  };
}

export const isChatActive = (state: ChatState): boolean =>
  state.lifecycle.session === "available" && state.lifecycle.instance === "active";

export const statusFromPhase = (phase: SessionPhase): "streaming" | "ready" | "error" => {
  switch (phase) {
    case "idle":
      return "ready";
    case "crashed":
      return "error";
    default:
      return "streaming";
  }
};

export const includesValue = (values: ReadonlyArray<string>, value: string): boolean =>
  values.includes(value);

export function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export function removeValue(values: string[], value: string): boolean {
  const index = values.indexOf(value);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}
