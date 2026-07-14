import { Chat } from "./chat";
import { ChatTransport } from "./chat-transport";

// The narrow surface features are allowed to touch. Orchestration internals
// (the session map, disposal) stay on the class.
export interface ChatManagerApi {
  attach(sessionId: string): Chat;
}

// Owns the live Chat instances keyed by sessionId. Sessions survive route
// switches: attach() is get-or-create, and nothing disposes a Chat on
// navigation — its store keeps the transcript for the next mount.
export class ChatManager implements ChatManagerApi {
  #chats = new Map<string, Chat>();

  constructor(private readonly transport: ChatTransport) {}

  attach(sessionId: string): Chat {
    const existing = this.#chats.get(sessionId);
    if (existing) return existing;
    const chat = new Chat({ sessionId, transport: this.transport });
    this.#chats.set(sessionId, chat);
    return chat;
  }
}

// HMR-preserved singleton: a module-level `new` would leak a fresh manager
// (and duplicate WS subscriptions) on every hot update. Features must not
// import this directly — go through ChatManagerProvider / useChatManager.
const globalKey = Symbol.for("vibest.chatManager");
type GlobalWithManager = typeof globalThis & { [globalKey]?: ChatManager };
export const chatManager: ChatManager = ((globalThis as GlobalWithManager)[globalKey] ??=
  new ChatManager(new ChatTransport()));
