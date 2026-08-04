import { useMemo, type ReactNode } from "react";

import {
  TranscriptRenderContext,
  type TranscriptRenderContextValue,
} from "./transcript-render-context";

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
