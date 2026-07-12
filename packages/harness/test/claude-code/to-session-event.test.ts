import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { toSessionEvent } from "../../src/claude-code/to-session-event";
import type { LifecycleView } from "../../src/types/session";

const idle: LifecycleView = {
  sessionId: "s1",
  activeTurnId: undefined,
  nextTurnId: () => "turn-1",
};
const active: LifecycleView = {
  sessionId: "s1",
  activeTurnId: "turn-1",
  nextTurnId: () => "turn-2",
};

describe("toSessionEvent", () => {
  it("starts a turn on first assistant activity of an idle session", () => {
    const ev = toSessionEvent(
      { type: "assistant", message: { id: "m", content: [] } } as unknown as SDKMessage,
      idle,
    );
    expect(ev).toMatchObject({ type: "session.turn.started", sessionId: "s1", turnId: "turn-1" });
  });

  it("does not restart a turn that is already active", () => {
    const ev = toSessionEvent(
      { type: "assistant", message: { id: "m", content: [] } } as unknown as SDKMessage,
      active,
    );
    expect(ev).toBeUndefined();
  });

  it("ends the active turn on a successful result", () => {
    const msg = {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 3, output_tokens: 7 },
    } as unknown as SDKMessage;
    expect(toSessionEvent(msg, active)).toMatchObject({
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      usage: { inputTokens: 3, outputTokens: 7 },
    });
  });

  it("marks a non-success result as failed", () => {
    const msg = { type: "result", subtype: "error_during_execution" } as unknown as SDKMessage;
    expect(toSessionEvent(msg, active)).toMatchObject({
      type: "session.turn.ended",
      outcome: "failed",
    });
  });

  it("returns undefined for a result when no turn is active", () => {
    const msg = { type: "result", subtype: "success" } as unknown as SDKMessage;
    expect(toSessionEvent(msg, idle)).toBeUndefined();
  });
});
