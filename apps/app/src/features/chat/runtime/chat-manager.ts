import type { SessionRef } from "@vibest/contract";

import { sessionRefKey } from "@/lib/session-ref";

import { Chat } from "./chat";
import type { ChatSessionTransportFactory } from "./chat-transport-port";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  chatFor(sessionRef: SessionRef): Chat;
}

// Owns the live Chat instances keyed by the complete SessionRef. Sessions survive
// route switches: chatFor() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount. The one
// exception is eviction below. Each Chat gets its own transport, minted from
// the injected factory and bound to its SessionRef; the manager knows nothing
// about oRPC or the wire client.
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
    const key = sessionRefKey(sessionRef);
    const existing = this.#chats.get(key);
    if (existing) return existing;
    const chat = new Chat({
      sessionRef,
      transport: this.createTransport(sessionRef),
      onTerminated: () => this.#evict(key),
    });
    this.#chats.set(key, chat);
    return chat;
  }

  // The server declared the stream over (archived, deleted — the Chat doesn't
  // distinguish, and neither does this). Drop the cache entry and release the
  // subscription; the store itself is left alone, because whoever is rendering
  // this session right now still holds the instance and needs its terminal
  // error on screen. That view keeps working, the transcript is collected once
  // it unmounts, and a session restored later gets a Chat built from scratch —
  // which is also what un-sticks `#terminated`, a flag nothing ever clears.
  //
  // Safe to look the entry up rather than compare identities: `closed` reaches
  // a Chat only from inside the subscription's async loop, so the `set` below
  // has always run by the time this fires.
  #evict(key: string): void {
    const chat = this.#chats.get(key);
    if (!chat) return;
    this.#chats.delete(key);
    chat.dispose();
  }
}
