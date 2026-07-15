import type { InferUIMessageChunk } from "ai";

import type { ClaudeCodeUIMessage } from "../claude-code/ui-message";
import type { CodexUIMessage } from "../codex/ui-message";

export type ClaudeCodeUIMessageChunk = InferUIMessageChunk<ClaudeCodeUIMessage>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;

export { isSessionEvent } from "@vibest/contract/session-events";
export {
  type HarnessAgentId,
  type SessionEnvelope,
  type SessionEnvelopeBody,
  type SessionEnvelopeDraft,
} from "@vibest/contract";
