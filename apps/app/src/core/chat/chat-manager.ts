import { Chat } from "./chat";
import type { OrpcChatSessionTransport } from "./chat-transport";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  attach(sessionId: string): Chat;
}

// Owns the live Chat instances keyed by sessionId. Sessions survive route
// switches: attach() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount.
// Constructed once when the shared App mounts, not at module scope:
// a module-level `new` cannot see the host connection the entry supplied.
export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly transport: OrpcChatSessionTransport) {}

  attach(sessionId: string): Chat {
    const existing = this.#chats.get(sessionId);
    if (existing) return existing;
    const chat = new Chat({ sessionId, transport: this.transport });
    this.#chats.set(sessionId, chat);
    return chat;
  }
}
