import { expect, it } from "vitest";

import { toSessionEvent } from "../../../src/harness/grok/to-session-event";

const view = {
  sessionId: "s1",
  activeTurnId: "t1",
  nextTurnId: () => "t2",
};

it("maps turn_completed onto session.turn.ended", () => {
  expect(
    toSessionEvent(
      {
        method: "_x.ai/session_notification",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "turn_completed",
            stop_reason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        },
      },
      view,
    ),
  ).toEqual({
    type: "session.turn.ended",
    sessionId: "s1",
    turnId: "t1",
    outcome: "completed",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    },
  });
});

it("maps a cancelled stop reason", () => {
  expect(
    toSessionEvent(
      {
        method: "_x.ai/session_notification",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "turn_completed", stop_reason: "cancelled" },
        },
      },
      view,
    ),
  ).toMatchObject({ outcome: "canceled" });
});

it("ignores chunk-track notifications", () => {
  expect(
    toSessionEvent(
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      },
      view,
    ),
  ).toBeUndefined();
});
