import type { InferUIMessageChunk, UIMessage } from "ai";

import type { AgentSessionEvent } from "./protocol";
import type { PiTools } from "./tools";

export type PiMetadata = {
  /** Pi session id (a uuid we assign via `--session-id`). */
  sessionId: string;
};

type Event<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

/** The assistant message minus its content — the content already streamed as text/reasoning/tool chunks. */
export type PiAssistantSummary = Pick<
  Extract<Event<"message_end">["message"], { role: "assistant" }>,
  "model" | "provider" | "usage" | "stopReason" | "errorMessage"
>;

// `data-*` parts forward whole event payloads verbatim (mirrors codex/ui-message.ts).
export type PiDataTypes = {
  "message/end": PiAssistantSummary;
  "compaction/start": Event<"compaction_start">;
  "compaction/end": Event<"compaction_end">;
  "retry/start": Event<"auto_retry_start">;
  "retry/end": Event<"auto_retry_end">;
};

export type PiUIMessage = UIMessage<PiMetadata, PiDataTypes, PiTools>;
export type PiUIMessageChunk = InferUIMessageChunk<PiUIMessage>;
