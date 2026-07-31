import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { SessionEvent } from "../event-manifest";
import type { LifecycleView } from "../types/session";

const ACTIVITY = new Set<SDKMessage["type"]>(["assistant", "user", "stream_event"]);

/** Fold a native message into a control event. Render content is handled by `transform`. */
export function toSessionEvent(message: SDKMessage, view: LifecycleView): SessionEvent | undefined {
  if (message.type === "result") {
    if (view.activeTurnId === undefined) return undefined;
    const usage = message.usage;
    return {
      type: "session.turn.ended",
      sessionId: view.sessionId,
      turnId: view.activeTurnId,
      outcome: message.subtype === "success" ? "completed" : "failed",
      usage: usage
        ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
          }
        : undefined,
    };
  }

  if (view.activeTurnId === undefined && ACTIVITY.has(message.type)) {
    return { type: "session.turn.started", sessionId: view.sessionId, turnId: view.nextTurnId() };
  }

  return undefined;
}
