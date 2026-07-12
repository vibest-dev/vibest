import type { UIMessage } from "ai";
import type { ClaudeCodeTools } from "./index";

export type ClaudeCodeMetadata = unknown;
export type ClaudeCodeDataTypes = Record<string, never>;
export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
