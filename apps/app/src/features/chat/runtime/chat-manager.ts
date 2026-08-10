import type { SessionRef } from "@vibest/contract";

import { Chat } from "./chat";
import type { ChatSessionTransportFactory } from "./chat-transport-port";

export interface ChatManagerApi {
  chatFor(sessionRef: SessionRef): Chat;
}

const keyFor = (ref: SessionRef): string =>
  [ref.projectId, ref.harnessAgentId, ref.sessionId]
    .map((part) => `${part.length}:${part}`)
    .join("|");

export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly createTransport: ChatSessionTransportFactory) {}

  chatFor(sessionRef: SessionRef): Chat {
    const key = keyFor(sessionRef);
    const existing = this.#chats.get(key);
    if (existing) return existing;

    let chat: Chat | undefined;
    let terminatedDuringConstruction = false;
    const created = new Chat({
      sessionRef,
      transport: this.createTransport(sessionRef),
      onTerminated: () => {
        if (chat) this.#evict(key, chat);
        else terminatedDuringConstruction = true;
      },
    });
    chat = created;
    this.#chats.set(key, created);
    if (terminatedDuringConstruction) this.#evict(key, created);
    return created;
  }

  #evict(key: string, expected: Chat): void {
    if (this.#chats.get(key) !== expected) return;
    this.#chats.delete(key);
    expected.dispose();
  }
}
