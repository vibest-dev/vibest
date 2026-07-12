import type { InferUIMessageChunk } from "ai";

import type { ClaudeCodeUIMessage } from "../claude-code/ui-message";
import type { CodexUIMessage } from "../codex/ui-message";
import type { SessionEvent } from "../event-manifest";
import type { HarnessAgentId } from "./harness-agent-id";

export type ClaudeCodeUIMessageChunk = InferUIMessageChunk<ClaudeCodeUIMessage>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;

/** A render chunk (hyphenated type) or a control event (dotted type). */
export type SessionEnvelopeBody = ClaudeCodeUIMessageChunk | CodexUIMessageChunk | SessionEvent;

// seq is stamped by the server EventBus (out of scope here); adapters emit drafts.
export type SessionEnvelope =
  | {
      harnessAgentId: "claude-code";
      sessionId: string;
      seq: number;
      body: ClaudeCodeUIMessageChunk | SessionEvent;
    }
  | {
      harnessAgentId: "codex";
      sessionId: string;
      seq: number;
      body: CodexUIMessageChunk | SessionEvent;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SessionEnvelopeDraft = DistributiveOmit<SessionEnvelope, "seq">;

// The whole routing decision: event types always contain a dot, chunk types never do.
export const isSessionEvent = (body: SessionEnvelopeBody): body is SessionEvent =>
  body.type.includes(".");

export type { HarnessAgentId };
