import type { SessionRef } from "@vibest/contract";

import { Chat } from "./chat";
import type { ChatSessionTransportFactory } from "./chat-transport-port";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  chatFor(sessionRef: SessionRef): Chat;
}

// Owns the live Chat instances keyed by the session's uuid. Sessions survive
// route switches: chatFor() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount. Each Chat
// gets its own transport, minted from the injected factory and bound to its
// SessionRef; the manager knows nothing about oRPC or the wire client.
// Constructed once when the shared App mounts, not at module scope: a
// module-level `new` cannot see the host connection the entry supplied.
export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly createTransport: ChatSessionTransportFactory) {}

  // The harness is fixed at the first call for a session (a session's harness
  // never changes); later calls return the existing Chat. The harness travels
  // on the SessionRef, so cold-loaded session routes and the session-creating
  // caller alike carry the real harness rather than a default.
  chatFor(sessionRef: SessionRef): Chat {
    const existing = this.#chats.get(sessionRef.sessionId);
    if (existing) return existing;
    const chat = new Chat({
      sessionRef,
      transport: this.createTransport(sessionRef),
    });
    this.#chats.set(sessionRef.sessionId, chat);
    return chat;
  }
}
