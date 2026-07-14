import { createContext, useContext, type ReactNode } from "react";

import type { ChatManagerApi } from "./chat-manager";

// Consumers only see the narrow ChatManagerApi (not the ChatManager class).
// There is no default: the manager is built by the host entry point, so a
// missing provider is a wiring bug, not something to paper over with a
// second, silently-unshared instance.
const ChatManagerContext = createContext<ChatManagerApi | null>(null);

export function ChatManagerProvider({
  manager,
  children,
}: {
  manager: ChatManagerApi;
  children: ReactNode;
}) {
  return <ChatManagerContext.Provider value={manager}>{children}</ChatManagerContext.Provider>;
}

export function useChatManager(): ChatManagerApi {
  const manager = useContext(ChatManagerContext);
  if (!manager) {
    throw new Error("useChatManager must be used within a ChatManagerProvider");
  }
  return manager;
}
