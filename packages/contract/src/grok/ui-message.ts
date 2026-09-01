import type { InferUIMessageChunk, UIMessage } from "ai";

import type { GrokTools } from "./tools";

export type GrokMetadata = {
  /** Grok session id (UUIDv7 from `session/new`). */
  sessionId: string;
};

// No `data-*` parts — ACP session updates that are not text/reasoning/tools
// (commands, recap, hooks, queue) stay off the chunk track until a data part
// earns its keep.
export type GrokDataTypes = Record<never, never>;

export type GrokUIMessage = UIMessage<GrokMetadata, GrokDataTypes, GrokTools>;
export type GrokUIMessageChunk = InferUIMessageChunk<GrokUIMessage>;
