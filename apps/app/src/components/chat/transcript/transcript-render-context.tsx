import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { AgentProviderId } from "@/core/chat/chat";

export interface TranscriptRenderContextValue {
  agentProviderId: AgentProviderId;
}

const TranscriptRenderContext = createContext<TranscriptRenderContextValue | null>(null);

// Chat-level render constants, resolved once at ChatTranscript so transcript
// leaves (tool dispatch) read them from context instead of prop-drilling.
export function TranscriptRenderProvider({
  agentProviderId,
  children,
}: TranscriptRenderContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ agentProviderId }), [agentProviderId]);
  return (
    <TranscriptRenderContext.Provider value={value}>{children}</TranscriptRenderContext.Provider>
  );
}

// Throws outside the provider — every transcript component renders within
// ChatTranscript's provider, so absence is a programming error.
export function useTranscriptRender(): TranscriptRenderContextValue {
  const ctx = useContext(TranscriptRenderContext);
  if (!ctx) throw new Error("useTranscriptRender must be used within <TranscriptRenderProvider>");
  return ctx;
}
