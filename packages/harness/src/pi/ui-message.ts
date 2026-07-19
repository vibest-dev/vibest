import type { InferUIMessageChunk, UIMessage } from "ai";

import type { PiTools } from "./tools";

export type PiMetadata = {
  /** Pi session id (a uuid we assign via `--session-id`). */
  sessionId: string;
};

// No `data-*` parts (mirrors codex/ui-message.ts) — assistant summaries,
// compaction, and retry events stay off the chunk track until a data part
// earns its keep.
export type PiDataTypes = Record<never, never>;

export type PiUIMessage = UIMessage<PiMetadata, PiDataTypes, PiTools>;
export type PiUIMessageChunk = InferUIMessageChunk<PiUIMessage>;
