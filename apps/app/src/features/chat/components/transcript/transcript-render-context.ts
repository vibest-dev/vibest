import type { HarnessAgentId } from "@vibest/contract";
import { createContext, useContext } from "react";

export interface TranscriptRenderContextValue {
  harnessAgentId: HarnessAgentId;
}

export const TranscriptRenderContext = createContext<TranscriptRenderContextValue | null>(null);

// Throws outside the provider — every transcript component renders within
// ChatTranscript's provider, so absence is a programming error.
export function useTranscriptRender(): TranscriptRenderContextValue {
  const ctx = useContext(TranscriptRenderContext);
  if (!ctx) throw new Error("useTranscriptRender must be used within <TranscriptRenderProvider>");
  return ctx;
}
