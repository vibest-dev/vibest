import { describe, expect, it } from "vitest";

import { toWireBody } from "../../src/harness/session-fold";

const retry = {
  type: "session.turn.retry.started",
  sessionId: "session-1",
  turnId: "turn-1",
  attempt: 1,
  maxAttempts: 3,
  retryAt: 10_000,
} as const;

describe("toWireBody", () => {
  it("publishes retry state without exposing the internal turn correlation", () => {
    expect(toWireBody(retry, "turn-1")).toEqual({
      type: "session.turn.retry.started",
      attempt: 1,
      maxAttempts: 3,
      retryAt: 10_000,
    });
  });

  it("drops retry state from a stale turn", () => {
    expect(toWireBody(retry, "turn-2")).toBeNull();
  });
});
