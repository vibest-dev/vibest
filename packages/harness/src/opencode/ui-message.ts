import type { InferUIMessageChunk, UIMessage } from "ai";

import type { OpencodeTools } from "./tools";

export type OpencodeMetadata = {
  /** Opencode session id (kept as `sessionId` to match the provider-agnostic layer). */
  sessionId: string;
};

// No `data-*` parts yet — deliberately. Part arms with a native AI-SDK track
// map onto it (text → text-*, reasoning → reasoning-*, tool → tool-*,
// file → file, step-start/step-finish → start-step/finish-step); which of the
// remaining arms (snapshot/patch/agent/retry/compaction/subtask) and session
// events deserve a data part is decided when the transform lands.
export type OpencodeDataTypes = Record<never, never>;

export type OpencodeUIMessage = UIMessage<OpencodeMetadata, OpencodeDataTypes, OpencodeTools>;
export type OpencodeUIMessageChunk = InferUIMessageChunk<OpencodeUIMessage>;
