import type { InferUIMessageChunk } from "ai";

import type { ClaudeCodeUIMessage } from "../claude-code/ui-message";
import type { CodexUIMessage } from "../codex/ui-message";

export type ClaudeCodeUIMessageChunk = InferUIMessageChunk<ClaudeCodeUIMessage>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;

export type { HarnessAgentId } from "@vibest/contract";
export {
  isSessionEvent,
  type SessionEnvelope,
  type SessionEnvelopeBody,
  type SessionEnvelopeDraft,
} from "../events/framework";
