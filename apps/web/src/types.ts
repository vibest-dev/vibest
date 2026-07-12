import type { ClaudeCodeTools } from "@vibest/harness/claude-code";
import type { UIMessage } from "ai";

export type ClaudeCodeUIMessage = UIMessage<undefined, Record<string, never>, ClaudeCodeTools>;
