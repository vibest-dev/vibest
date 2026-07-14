import type { InferUIMessageChunk, UIMessage } from "ai";

import type {
  ThreadItem,
  ThreadStartedNotification,
  ThreadTokenUsage,
  TurnCompletedNotification,
  TurnError,
} from "./protocol/v2";
import type { CodexTools } from "./tools";

export type CodexMetadata = {
  /** Codex thread id (kept as `sessionId` to match the provider-agnostic layer). */
  sessionId: string;
};

type Item<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

// `data-*` parts carry the WHOLE payload verbatim (mirrors claude-code/ui-message.ts).
export type CodexDataTypes = {
  "thread/started": ThreadStartedNotification;
  "turn/completed": TurnCompletedNotification;
  "turn/error": TurnError;
  "thread/tokenUsage": ThreadTokenUsage;
  plan: Item<"plan">;
  hookPrompt: Item<"hookPrompt">;
  "review/entered": Item<"enteredReviewMode">;
  "review/exited": Item<"exitedReviewMode">;
  compaction: Item<"contextCompaction">;
  /** History replay only — never emitted by the live transform. */
  userMessage: Item<"userMessage">;
};

export type CodexUIMessage = UIMessage<CodexMetadata, CodexDataTypes, CodexTools>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;
