import type { HarnessAgentId } from "@vibest/contract";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface TranscriptRenderContextValue {
  harnessAgentId: HarnessAgentId;
}

const TranscriptRenderContext = createContext<TranscriptRenderContextValue | null>(null);

// Chat-level render constants, resolved once at ChatTranscript so transcript
// leaves (tool dispatch) read them from context instead of prop-drilling.
export function TranscriptRenderProvider({
  harnessAgentId,
  children,
}: TranscriptRenderContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ harnessAgentId }), [harnessAgentId]);
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
