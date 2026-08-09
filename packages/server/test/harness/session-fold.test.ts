import type { SessionRef, SessionScopedEvent, SessionScopedEventBody } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { foldSessionEvent, initialSessionState, toSnapshot } from "../../src/harness/session-fold";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
};

const event = (seq: number, body: SessionScopedEventBody): SessionScopedEvent => ({
  ...body,
  ref,
  seq,
});

describe("session prompt projection", () => {
  it("reveals the accepted running prompt when a newer candidate is rejected", () => {
    let state = foldSessionEvent(
      initialSessionState,
      event(1, {
        type: "session.prompt.submitted",
        messageId: "prompt-a",
        parts: [{ type: "text", text: "A" }],
      }),
    );
    state = foldSessionEvent(
      state,
      event(2, {
        type: "session.prompt.accepted",
        messageId: "prompt-a",
        turnId: "turn-a",
      }),
    );
    state = foldSessionEvent(
      state,
      event(3, {
        type: "session.prompt.submitted",
        messageId: "prompt-b",
        parts: [{ type: "text", text: "B" }],
      }),
    );

    expect(toSnapshot(ref, state)).toMatchObject({
      activePrompt: { messageId: "prompt-b", acceptedTurnId: null },
      acceptedPrompt: { messageId: "prompt-a", acceptedTurnId: "turn-a" },
      pendingPrompts: [{ messageId: "prompt-b", acceptedTurnId: null }],
    });

    state = foldSessionEvent(
      state,
      event(4, {
        type: "session.prompt.rejected",
        messageId: "prompt-b",
        reason: "turn running",
      }),
    );

    expect(toSnapshot(ref, state).activePrompt).toMatchObject({
      messageId: "prompt-a",
      acceptedTurnId: "turn-a",
    });
  });
});
