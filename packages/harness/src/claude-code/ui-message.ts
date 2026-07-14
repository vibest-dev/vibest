import type {
  SDKCompactBoundaryMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UIMessage } from "ai";

import type { ClaudeCodeTools } from "./tools";

export type ClaudeCodeMetadata = unknown;

// `data-*` parts carry the WHOLE SDK message as payload — the transform forwards
// `data: msg` verbatim, so the renderer keeps full fidelity. `result/<subtype>`
// is keyed off every SDKResultError subtype plus the success case.
export type ClaudeCodeDataTypes = {
  "system/init": SDKSystemMessage;
  "system/compact_boundary": SDKCompactBoundaryMessage;
  "result/success": SDKResultSuccess;
  /**
   * History replay only. The live transform never emits the user's own prompt;
   * a future transcript replayer emits the whole user record here.
   */
  "user-prompt": SDKUserMessage;
} & { [K in SDKResultError["subtype"] as `result/${K}`]: SDKResultError };

export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
