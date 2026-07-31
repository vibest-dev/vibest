import type { InferUIMessageChunk, UIMessage } from "ai";

import type { CodexTools } from "./tools";

export type CodexMetadata = {
  /** Codex thread id (kept as `sessionId` to match the provider-agnostic layer). */
  sessionId: string;
};

// No `data-*` parts (mirrors claude-code/ui-message.ts) — turn/thread payloads
// and non-streamed items (plan/hookPrompt/review/compaction/…) stay off the
// chunk track until a data part earns its keep.
export type CodexDataTypes = Record<never, never>;

export type CodexUIMessage = UIMessage<CodexMetadata, CodexDataTypes, CodexTools>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;
