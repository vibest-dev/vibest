import type { InferUIMessageChunk, UIMessage } from "ai";

import type { CursorTools } from "./tools";

export type CursorMetadata = {
  /** Cursor ACP session id from `session/new`. */
  sessionId: string;
};

// No `data-*` parts — ACP session updates that are not text/reasoning/tools
// stay off the chunk track until a data part earns its keep.
export type CursorDataTypes = Record<never, never>;

export type CursorUIMessage = UIMessage<CursorMetadata, CursorDataTypes, CursorTools>;
export type CursorUIMessageChunk = InferUIMessageChunk<CursorUIMessage>;
