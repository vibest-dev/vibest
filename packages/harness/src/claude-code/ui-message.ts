import type { UIMessage } from "ai";

import type { ClaudeCodeTools } from "./tools";

export type ClaudeCodeMetadata = unknown;

// No `data-*` parts — the chunk track carries text/reasoning/tool chunks plus
// start/finish/error only. SDK system/result payloads stay session-layer
// concerns (see to-session-event) until a data part earns its keep.
export type ClaudeCodeDataTypes = Record<never, never>;

export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
