import { createContext, useContext, type ReactNode } from "react";

import type { ChatManagerApi } from "./chat-manager";
import { chatManager as defaultChatManager } from "./chat-manager";

// Consumers only see the narrow ChatManagerApi (not the ChatManager class).
const ChatManagerContext = createContext<ChatManagerApi>(defaultChatManager);

// Default = the HMR-preserved singleton; tests can inject a double.
export function ChatManagerProvider({
  manager = defaultChatManager,
  children,
}: {
  manager?: ChatManagerApi;
  children: ReactNode;
}) {
  return <ChatManagerContext.Provider value={manager}>{children}</ChatManagerContext.Provider>;
}

export function useChatManager(): ChatManagerApi {
  return useContext(ChatManagerContext);
}
