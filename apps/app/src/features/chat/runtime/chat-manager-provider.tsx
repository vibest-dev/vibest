import type { ReactNode } from "react";

import { ChatManagerContext } from "./chat-context";
import type { ChatManagerApi } from "./chat-manager";

export function ChatManagerProvider({
  manager,
  children,
}: {
  manager: ChatManagerApi;
  children: ReactNode;
}) {
  return <ChatManagerContext.Provider value={manager}>{children}</ChatManagerContext.Provider>;
}
