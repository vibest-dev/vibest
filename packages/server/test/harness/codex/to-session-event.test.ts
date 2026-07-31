import type { ServerNotification } from "@vibest/contract/codex/protocol";
import { describe, expect, it } from "vitest";

import { toSessionEvent } from "../../../src/harness/codex/to-session-event";
import type { LifecycleView } from "../../../src/harness/types/session";

const view: LifecycleView = {
  sessionId: "th",
  activeTurnId: "t1",
  nextTurnId: () => "t2",
};
const n = (method: string, params: unknown) => ({ method, params }) as ServerNotification;

describe("codex toSessionEvent", () => {
  it("turn/started → session.turn.started", () => {
    expect(toSessionEvent(n("turn/started", { threadId: "th", turn: { id: "t1" } }), view)).toEqual(
      {
        type: "session.turn.started",
        sessionId: "th",
        turnId: "t1",
      },
    );
  });

  it("turn/completed maps status to outcome", () => {
    const done = toSessionEvent(
      n("turn/completed", { threadId: "th", turn: { id: "t1", status: "interrupted" } }),
      view,
    );
    expect(done).toMatchObject({ type: "session.turn.ended", outcome: "canceled" });
  });

  it("retryable error is silent; terminal error fails the turn", () => {
    expect(
      toSessionEvent(
        n("error", { threadId: "th", turnId: "t1", willRetry: true, error: { message: "x" } }),
        view,
      ),
    ).toBeUndefined();
    expect(
      toSessionEvent(
        n("error", { threadId: "th", turnId: "t1", willRetry: false, error: { message: "x" } }),
        view,
      ),
    ).toMatchObject({ type: "session.turn.ended", outcome: "failed" });
  });

  it("chunk-track notifications return undefined", () => {
    expect(toSessionEvent(n("item/started", { threadId: "th", item: {} }), view)).toBeUndefined();
  });
});
