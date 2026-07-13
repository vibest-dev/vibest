import { consumeEventIterator, eventIteratorToStream } from "@orpc/client";
import type { ToolPermissionRequest } from "@vibest/contract/claude-code";
import type { ChatTransport as AiChatTransport, UIMessage, UIMessageChunk } from "ai";

import { orpcClient, orpcWsClient } from "@/lib/orpc";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import { isAutoAllowed, toAgentRequest, toPermissionResult } from "./providers/claude-code/request";

export type ChatModel = "opus" | "sonnet";

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

// The provider boundary: wraps the oRPC clients behind an AI-SDK-shaped
// transport facade plus the agent-request plane. Everything above this class
// is provider-agnostic — raw wire events (original input, permission
// suggestions) are held here, keyed by request id, and never leave.
export class ChatTransport implements AiChatTransport<UIMessage> {
  #rawRequests = new Map<string, ToolPermissionRequest>();

  async sendMessages(
    options: Parameters<AiChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const message = options.messages.at(-1);
    if (!message) throw new Error("message is required");
    const model = (options.body as { model?: ChatModel } | undefined)?.model ?? "sonnet";
    const event = await orpcClient.claudeCode.prompt(
      { sessionId: options.chatId, message, model },
      { signal: options.abortSignal },
    );
    return eventIteratorToStream(event);
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  // Session-scoped agent-request subscription. Wire events are normalized to
  // provider-free AgentRequests before they reach the caller; auto-allowed
  // events (empty ExitPlanMode plan) are answered here and never surface.
  subscribeAgentRequests(
    sessionId: string,
    onRequest: (request: AgentRequest) => void,
  ): () => void {
    const abortController = new AbortController();
    const unsubscribe = consumeEventIterator(
      orpcWsClient.claudeCode.requestPermission({ sessionId }, { signal: abortController.signal }),
      {
        onEvent: (event) => {
          if (isAutoAllowed(event)) {
            void orpcWsClient.claudeCode.respondPermission({
              sessionId,
              requestId: event.requestId,
              result: { behavior: "allow", updatedInput: event.input },
            });
            return;
          }
          this.#rawRequests.set(event.requestId, event);
          onRequest(toAgentRequest(event));
        },
        onError: (streamError) => {
          if (!isAbortError(streamError)) console.error("Agent request stream error:", streamError);
        },
        onFinish: () => {},
      },
    );
    return () => {
      abortController.abort();
      void unsubscribe().catch((unsubscribeError) => {
        if (!isAbortError(unsubscribeError)) {
          console.error("Failed to unsubscribe from agent request stream", unsubscribeError);
        }
      });
    };
  }

  async respondToAgentRequest(
    sessionId: string,
    requestId: string,
    response: AgentResponse,
  ): Promise<void> {
    const event = this.#rawRequests.get(requestId);
    if (!event) throw new Error(`Unknown agent request: ${requestId}`);
    await orpcWsClient.claudeCode.respondPermission({
      sessionId,
      requestId,
      result: toPermissionResult(event, response),
    });
    this.#rawRequests.delete(requestId);
  }
}
