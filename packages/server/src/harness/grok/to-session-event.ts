import type { SessionEvent } from "../event-manifest";
import type { LifecycleView } from "../types/session";
import { isXaiSessionNotification, type RpcNotification } from "./protocol";

/** Map control-plane ACP / x.ai notifications to SessionEvents. Chunk-track → undefined. */
export function toSessionEvent(
  notification: RpcNotification,
  view: LifecycleView,
): SessionEvent | undefined {
  if (!isXaiSessionNotification(notification)) return undefined;
  const update = notification.params.update;
  if (update.sessionUpdate !== "turn_completed") return undefined;
  if (view.activeTurnId === undefined) return undefined;
  const usage = update.usage;
  const cancelled = update.stop_reason === "cancelled" || update.stop_reason === "canceled";
  return {
    type: "session.turn.ended",
    sessionId: view.sessionId,
    turnId: view.activeTurnId,
    outcome: cancelled ? "canceled" : "completed",
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
        }
      : undefined,
  };
}
