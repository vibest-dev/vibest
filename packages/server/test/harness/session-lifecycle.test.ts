import { describe, expect, it } from "@effect/vitest";

import {
  initialLifecycleState,
  reduceLifecycle,
  type LifecycleCommand,
} from "../../src/harness/session-lifecycle";

const run = (commands: ReadonlyArray<LifecycleCommand>) => {
  let state = initialLifecycleState("session-1");
  const events: Array<{ readonly type: string }> = [];
  const actions: Array<{ readonly type: string; readonly requestId: string }> = [];

  for (const command of commands) {
    const transition = reduceLifecycle(state, command);
    if (!transition.ok) return transition;
    state = transition.state;
    events.push(...transition.events);
    actions.push(...transition.actions);
  }

  return { ok: true as const, state, events, actions };
};

describe("SessionLifecycle", () => {
  it("emits one started and one ended event for a turn", () => {
    const result = run([
      { type: "turn.start", turnId: "turn-1" },
      { type: "turn.end", turnId: "turn-1", outcome: "completed" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.type)).toEqual([
      "session.turn.started",
      "session.turn.ended",
    ]);
    expect(result.state.activeTurnId).toBeUndefined();
  });

  it("rejects ending a turn that is not active", () => {
    const result = run([{ type: "turn.end", turnId: "turn-1", outcome: "completed" }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("LifecycleViolation");
  });

  it("tracks a request until it is replied", () => {
    const result = run([
      {
        type: "request.ask",
        request: {
          type: "tool",
          id: "request-1",
          harnessAgentId: "codex",
          toolName: "Bash",
          input: { command: "pwd" },
          actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
          native: {},
        },
      },
      {
        type: "request.reply",
        requestId: "request-1",
        response: { type: "tool", behavior: "allow" },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.type)).toEqual([
      "session.request.asked",
      "session.request.replied",
    ]);
    expect(result.actions).toMatchObject([{ type: "reply", requestId: "request-1" }]);
  });

  it("returns AgentRequestUnavailable for a duplicate reply", () => {
    const result = run([
      {
        type: "request.ask",
        request: {
          type: "plan",
          id: "request-1",
          harnessAgentId: "claude-code",
          plan: "Plan",
          native: {},
        },
      },
      {
        type: "request.reply",
        requestId: "request-1",
        response: { type: "plan", behavior: "allow" },
      },
      {
        type: "request.reply",
        requestId: "request-1",
        response: { type: "plan", behavior: "allow" },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AgentRequestUnavailable");
  });

  it("rejects pending requests when the session closes", () => {
    const result = run([
      {
        type: "request.ask",
        request: {
          type: "plan",
          id: "request-1",
          harnessAgentId: "claude-code",
          plan: "Plan",
          native: {},
        },
      },
      { type: "session.close" },
      { type: "session.closed" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toMatchObject([{ type: "reject", requestId: "request-1" }]);
    expect(result.events.map((event) => event.type)).toContain("session.request.rejected");
    expect(result.state.phase).toBe("closed");
  });

  it("emits crash and rejection events before reaching crashed", () => {
    const result = run([
      {
        type: "request.ask",
        request: {
          type: "plan",
          id: "request-1",
          harnessAgentId: "claude-code",
          plan: "Plan",
          native: {},
        },
      },
      { type: "session.crash", reason: "process exited" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.type)).toEqual([
      "session.request.asked",
      "session.crashed",
      "session.request.rejected",
    ]);
    expect(result.state.phase).toBe("crashed");
  });
});
