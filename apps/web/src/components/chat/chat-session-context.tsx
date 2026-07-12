import { useChat } from "@ai-sdk/react";
import { consumeEventIterator, eventIteratorToStream } from "@orpc/client";
import type { ToolPermissionRequest } from "@vibest/contract/claude-code";
import type { ChatStatus } from "ai";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import { orpcClient, orpcWsClient } from "@/lib/orpc";
import type { ClaudeCodeUIMessage } from "@/types";

import { type AgentRequest, type AgentResponse } from "./agent-requests";
import { toAgentRequest, toPermissionResult } from "./claude-code-requests";

export type ChatModel = "opus" | "sonnet";

export interface ChatSessionValue {
  sessionId: string;
  messages: ClaudeCodeUIMessage[];
  status: ChatStatus;
  error?: Error;
  /** A turn is producing a reply (submitted / streaming). */
  turnInProgress: boolean;
  prompt: (text: string) => void;
  model: ChatModel;
  setModel: (model: ChatModel) => void;
  /** Agent requests awaiting a user decision, rendered inline by the transcript. */
  pendingRequests: AgentRequest[];
  respondToRequest: (requestId: string, response: AgentResponse) => void;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("useChatSession must be used within ChatSessionProvider");
  return value;
}

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

// The only place that holds the sessionId: owns the useChat transport, the
// session-scoped config (model), and the pending agent requests, and provides
// them to peer components (ChatTranscript / ChatInputComposer / ChatModelSelect)
// via context.
export function ChatSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const [model, setModel] = useState<ChatModel>("sonnet");
  const [pendingRequests, setPendingRequests] = useState<AgentRequest[]>([]);
  // Raw wire events keyed by request id: the claude-code boundary needs the
  // original input/suggestions at respond time; the UI never sees them.
  const rawRequestsRef = useRef(new Map<string, ToolPermissionRequest>());
  // useChat captures the transport once; read session/model through latest-refs
  // so sends always target the current session and model.
  const sessionIdRef = useLatestRef(sessionId);
  const modelRef = useLatestRef(model);

  const { messages, sendMessage, status, error } = useChat<ClaudeCodeUIMessage>({
    transport: {
      async sendMessages(options) {
        try {
          const message = options.messages.at(-1);
          if (!message) {
            throw new Error("message is required");
          }
          const event = await orpcClient.claudeCode.prompt(
            { sessionId: sessionIdRef.current, message, model: modelRef.current },
            { signal: options.abortSignal },
          );
          return eventIteratorToStream(event);
        } catch (sendError) {
          console.error("Failed to send messages", sendError);
          throw sendError;
        }
      },
      reconnectToStream() {
        throw new Error("Unsupported yet");
      },
    },
    onFinish: () => {
      // Turn ended: unanswered requests are stale — drop them so no ghost card
      // lingers in the transcript.
      rawRequestsRef.current.clear();
      setPendingRequests([]);
    },
  });

  // Session-scoped subscription: permission prompts arrive over WS while a
  // prompt runs and surface as pending requests in the transcript.
  useEffect(() => {
    const abortController = new AbortController();
    const rawRequests = rawRequestsRef.current;
    const unsubscribe = consumeEventIterator(
      orpcWsClient.claudeCode.requestPermission({ sessionId }, { signal: abortController.signal }),
      {
        onEvent: (event) => {
          rawRequests.set(event.requestId, event);
          const request = toAgentRequest(event);
          // Idempotent by id: a replayed event updates in place.
          setPendingRequests((prev) =>
            prev.some((r) => r.id === request.id)
              ? prev.map((r) => (r.id === request.id ? request : r))
              : [...prev, request],
          );
        },
        onError: (streamError) => {
          if (!isAbortError(streamError)) console.error("Tool permission error:", streamError);
        },
        onFinish: () => {},
      },
    );
    return () => {
      abortController.abort();
      rawRequests.clear();
      setPendingRequests([]);
      void unsubscribe().catch((unsubscribeError) => {
        if (!isAbortError(unsubscribeError)) {
          console.error("Failed to unsubscribe from tool permission stream", unsubscribeError);
        }
      });
    };
  }, [sessionId]);

  const respondToRequest = async (requestId: string, response: AgentResponse) => {
    const event = rawRequestsRef.current.get(requestId);
    if (!event) return;
    // Optimistic: the card closes immediately; restore it if the transport fails
    // so the user can answer again.
    setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    try {
      await orpcWsClient.claudeCode.respondPermission({
        sessionId: sessionIdRef.current,
        requestId,
        result: toPermissionResult(event, response),
      });
      rawRequestsRef.current.delete(requestId);
    } catch (respondError) {
      console.error("Failed to respond to permission request", respondError);
      const request = toAgentRequest(event);
      setPendingRequests((prev) =>
        prev.some((r) => r.id === request.id) ? prev : [...prev, request],
      );
    }
  };

  const value: ChatSessionValue = {
    sessionId,
    messages,
    status,
    error,
    turnInProgress: status === "submitted" || status === "streaming",
    prompt: (text) => {
      sendMessage({ parts: [{ type: "text", text }] });
    },
    model,
    setModel,
    pendingRequests,
    respondToRequest,
  };

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
