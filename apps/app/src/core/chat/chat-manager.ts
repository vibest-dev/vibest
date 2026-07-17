import type { SessionRef } from "@vibest/contract";

import { Chat } from "./chat";
import { type ChatTransportClient, OrpcChatSessionTransport } from "./chat-transport";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  attach(sessionRef: SessionRef): Chat;
}

// Owns the live Chat instances keyed by the session's uuid. Sessions survive
// route switches: attach() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount. Each Chat
// gets its own transport bound to its SessionRef.
// Constructed once when the shared App mounts, not at module scope: a
// module-level `new` cannot see the host connection the entry supplied.
export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly client: ChatTransportClient) {}

  attach(sessionRef: SessionRef): Chat {
    const existing = this.#chats.get(sessionRef.sessionId);
    if (existing) return existing;
    const chat = new Chat({
      sessionRef,
      transport: new OrpcChatSessionTransport(this.client, sessionRef),
    });
    this.#chats.set(sessionRef.sessionId, chat);
    return chat;
  }
}
