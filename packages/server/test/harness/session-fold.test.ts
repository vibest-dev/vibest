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
  streamId: "stream-1",
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

    expect(toSnapshot(ref, "stream-1", state)).toMatchObject({
      activePrompt: { messageId: "prompt-b", acceptedTurnId: null },
      acceptedPrompt: { messageId: "prompt-a", acceptedTurnId: "turn-a" },
      acceptedPrompts: [{ messageId: "prompt-a", acceptedTurnId: "turn-a" }],
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

    expect(toSnapshot(ref, "stream-1", state).activePrompt).toMatchObject({
      messageId: "prompt-a",
      acceptedTurnId: "turn-a",
    });
  });

  it("retains multiple accepted correlations in order, dedupes, and expires them at turn end", () => {
    let state = foldSessionEvent(
      initialSessionState,
      event(1, {
        type: "session.prompt.submitted",
        messageId: "steer-a",
        parts: [{ type: "text", text: "A" }],
      }),
    );
    state = foldSessionEvent(
      state,
      event(2, { type: "session.prompt.accepted", messageId: "steer-a", turnId: "turn-1" }),
    );
    state = foldSessionEvent(
      state,
      event(3, {
        type: "session.prompt.submitted",
        messageId: "steer-b",
        parts: [{ type: "text", text: "B" }],
      }),
    );
    state = foldSessionEvent(
      state,
      event(4, { type: "session.prompt.accepted", messageId: "steer-b", turnId: "turn-1" }),
    );
    // A duplicate accepted event from another delivery path does not reorder or
    // duplicate the authoritative correlation.
    state = foldSessionEvent(
      state,
      event(5, { type: "session.prompt.accepted", messageId: "steer-a", turnId: "turn-1" }),
    );

    expect(toSnapshot(ref, state).acceptedPrompts).toEqual([
      {
        messageId: "steer-a",
        parts: [{ type: "text", text: "A" }],
        seq: 1,
        acceptedTurnId: "turn-1",
      },
      {
        messageId: "steer-b",
        parts: [{ type: "text", text: "B" }],
        seq: 3,
        acceptedTurnId: "turn-1",
      },
    ]);

    state = foldSessionEvent(
      state,
      event(6, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed" }),
    );
    expect(toSnapshot(ref, state)).toMatchObject({
      acceptedPrompt: null,
      acceptedPrompts: [],
    });
  });
});
