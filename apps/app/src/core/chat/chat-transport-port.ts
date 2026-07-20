import type { SessionRef } from "@vibest/contract";
import type { ChatTransport as AiChatTransport, UIMessage } from "ai";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import type { ChatModel, ChatPermissionMode } from "./chat-config";

// The seam between Chat orchestration and any concrete wire implementation.
// Chat and ChatManager depend only on this port; the oRPC binding
// (OrpcChatSessionTransport) implements it and is injected at the composition
// root, so nothing in the core knows about oRPC or the WebSocket client.
export interface ChatSessionTransport extends AiChatTransport<UIMessage> {
  // The agent-request plane rides the same session transport as the prompt
  // stream, but sits outside the AI SDK transport interface — so the port adds
  // it explicitly.
  subscribeAgentRequests(
    onRequest: (request: AgentRequest) => void,
    onRequestResolved?: (requestId: string) => void,
  ): () => void;
  respondToAgentRequest(requestId: string, response: AgentResponse): Promise<void>;
  // Session-scoped config setters — separate session calls, never bundled into
  // a prompt turn. The transport already knows its SessionRef.
  setModel(model: ChatModel): Promise<void>;
  setPermissionMode(mode: ChatPermissionMode): Promise<void>;
}

// Binds a SessionRef to a transport. ChatManager holds one of these instead of
// the wire client, so swapping the oRPC binding for anything else is a one-line
// change at the composition root.
export type ChatSessionTransportFactory = (sessionRef: SessionRef) => ChatSessionTransport;
