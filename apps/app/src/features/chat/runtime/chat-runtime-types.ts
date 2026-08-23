import type { PromptPart } from "@vibest/contract";
import type { UIMessage, UIMessageChunk } from "ai";

import type { AgentResponse } from "./agent-requests";
import type { ChatState } from "./chat-state";
import type { ChatTransportEvent } from "./chat-transport-port";

export type ChatInput =
  | { readonly type: "transportEvent"; readonly event: ChatTransportEvent }
  | {
      readonly type: "promptRequested";
      readonly message: UIMessage;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  | { readonly type: "steerRequested"; readonly messageId: string }
  | {
      readonly type: "outgoingCompleted";
      readonly messageId: string;
      readonly delivery: "follow-up" | "steer";
      readonly error?: Error;
    }
  | {
      readonly type: "historyCompleted";
      readonly id: number;
      readonly purpose: "floor" | "reconcile";
      readonly history?: ReadonlyArray<UIMessage> | null;
      readonly error?: unknown;
    }
  | {
      readonly type: "foldUpdated";
      readonly turnId: string;
      readonly generation: number;
      readonly message: UIMessage;
    }
  | {
      readonly type: "foldFinished";
      readonly turnId: string;
      readonly generation: number;
      readonly error?: unknown;
    }
  | {
      readonly type: "requestResponseStarted";
      readonly operationId: string;
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | {
      readonly type: "requestResponseCompleted";
      readonly operationId: string;
      readonly error?: unknown;
    }
  | { readonly type: "dispose" };

export type ChatEffect =
  | { readonly type: "readHistory"; readonly id: number; readonly purpose: "floor" | "reconcile" }
  | { readonly type: "cancelHistory"; readonly id: number }
  | {
      readonly type: "submitPrompt";
      readonly messageId: string;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  | {
      readonly type: "submitSteer";
      readonly expectedTurnId: string;
      readonly messageId: string;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  | {
      readonly type: "respondToRequest";
      readonly operationId: string;
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | { readonly type: "openFold"; readonly turnId: string; readonly generation: number }
  | {
      readonly type: "appendFold";
      readonly turnId: string;
      readonly generation: number;
      readonly chunk: UIMessageChunk;
    }
  | { readonly type: "closeFold"; readonly turnId: string; readonly generation: number }
  | { readonly type: "resolvePrompt"; readonly messageId: string }
  | { readonly type: "rejectPrompt"; readonly messageId: string; readonly error: Error }
  | { readonly type: "settleResponse"; readonly operationId: string }
  | { readonly type: "abortLifetime" }
  | { readonly type: "unsubscribe" }
  | { readonly type: "notifyTerminated" }
  | { readonly type: "logError"; readonly message: string; readonly error: unknown };

export type ChatTransition = {
  readonly state: ChatState;
  readonly effects: ReadonlyArray<ChatEffect>;
};

export type ChatDraft = ChatState;
export type ChatEffects = ChatEffect[];
