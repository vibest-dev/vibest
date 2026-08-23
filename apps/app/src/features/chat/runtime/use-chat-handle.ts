import type { SessionRef } from "@vibest/contract";
import { useMemo } from "react";

import type { Chat } from "./chat";
import { useChatManager } from "./chat-context";
import type { ChatStoreState } from "./chat-state";

// Whether the turn is producing a reply (submitted / streaming). Used as a
// useStore selector so consumers that only care about this bit (the composer)
// don't re-render per streamed token.
export const selectTurnInProgress = (s: ChatStoreState): boolean =>
  s.status === "submitted" || s.status === "streaming";

// Get-or-create a Chat by SessionRef and return it with a stable identity.
// This hook does not subscribe to the store — consumers that read state do
// their own useStore(chat.store, selector).
export function useChatHandle(sessionRef: SessionRef): Chat {
  const manager = useChatManager();
  // Depend on the primitive fields, not the (per-render) ref object identity, so
  // the lookup runs once per distinct session rather than on every render.
  const { projectId, harnessAgentId, sessionId } = sessionRef;
  return useMemo(
    () => manager.chatFor({ projectId, harnessAgentId, sessionId }),
    [manager, projectId, harnessAgentId, sessionId],
  );
}
