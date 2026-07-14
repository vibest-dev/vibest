import type { SessionEvent } from "../event-manifest";
import type { LifecycleView } from "../types/session";
import type { ServerNotification } from "./protocol";

/** Map control-plane app-server notifications to SessionEvents. Chunk-track → undefined. */
export function toSessionEvent(
  notification: ServerNotification,
  view: LifecycleView,
): SessionEvent | undefined {
  switch (notification.method) {
    case "turn/started":
      return {
        type: "session.turn.started",
        sessionId: view.sessionId,
        turnId: notification.params.turn.id,
      };
    case "turn/completed": {
      const turn = notification.params.turn;
      if (turn.status === "interrupted") {
        return {
          type: "session.turn.ended",
          sessionId: view.sessionId,
          turnId: turn.id,
          outcome: "canceled",
        };
      }
      if (turn.status === "failed") {
        return {
          type: "session.turn.ended",
          sessionId: view.sessionId,
          turnId: turn.id,
          outcome: "failed",
          error: { message: turn.error?.message ?? "turn failed", category: "unknown" },
        };
      }
      return {
        type: "session.turn.ended",
        sessionId: view.sessionId,
        turnId: turn.id,
        outcome: "completed",
      };
    }
    case "error":
      // Retryable errors stay silent — the app-server will try again. A terminal
      // error fails the turn.
      if (notification.params.willRetry) return undefined;
      return {
        type: "session.turn.ended",
        sessionId: view.sessionId,
        turnId: notification.params.turnId,
        outcome: "failed",
        error: { message: notification.params.error.message, category: "unknown" },
      };
    default:
      return undefined;
  }
}
