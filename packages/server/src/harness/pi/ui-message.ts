import type { InferUIMessageChunk, UIMessage } from "ai";

import type { SessionMessageEntry } from "./protocol";
import type { PiTools } from "./tools";

type PiAssistantHistoryMessage = Extract<SessionMessageEntry["message"], { role: "assistant" }>;

export type PiMetadata = {
  /** Pi session id (a uuid we assign via `--session-id`). */
  sessionId: string;
  /** Identifies one native Pi run; all steer-created assistant segments share it. */
  runId?: string;
  /** Monotonic assistant segment within one native run; steer starts a new segment. */
  segment?: number;
  // History enrichment: only messages folded from disk carry these — the live
  // stream never surfaces usage/model, so live/history metadata is asymmetric
  // by design (docs/design/pi-history-read-design.md §5). Values come from the
  // segment's last assistant entry; `usage.cost` carries the cost breakdown.
  model?: PiAssistantHistoryMessage["model"];
  provider?: PiAssistantHistoryMessage["provider"];
  stopReason?: PiAssistantHistoryMessage["stopReason"];
  usage?: PiAssistantHistoryMessage["usage"];
};

// No `data-*` parts (mirrors codex/ui-message.ts) — assistant summaries,
// compaction, and retry events stay off the chunk track until a data part
// earns its keep.
export type PiDataTypes = Record<never, never>;

export type PiUIMessage = UIMessage<PiMetadata, PiDataTypes, PiTools>;
export type PiUIMessageChunk = InferUIMessageChunk<PiUIMessage>;
