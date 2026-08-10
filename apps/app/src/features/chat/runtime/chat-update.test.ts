import type { SessionRuntimeSnapshot } from "@vibest/contract";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createChatState, type ChatState } from "./chat-state";
import { updateChat } from "./chat-update";
import { buildChatView } from "./chat-view";

const ref = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
} as const;

const snapshot = (overrides: Partial<SessionRuntimeSnapshot> = {}): SessionRuntimeSnapshot => ({
  ref,
  status: { phase: "idle" },
  activeTurn: null,
  activePrompt: null,
  acceptedPrompt: null,
  pendingPrompts: [],
  pendingRequests: [],
  cursor: 0,
  ...overrides,
});

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const requested = (id: string, text: string) => ({
  type: "promptRequested" as const,
  message: userMessage(id, text),
  parts: [{ type: "text" as const, text }],
});

describe("updateChat", () => {
  it("builds the initial view from one complete state", () => {
    expect(buildChatView(createChatState())).toEqual({
      messages: [],
      queuedMessages: [],
      status: "ready",
      error: undefined,
      pendingRequests: [],
      historyStatus: "loading",
    });
  });

  it("keeps a prompt queued until the history floor commits, then dispatches atomically", () => {
    let transition = updateChat(createChatState(), requested("message-1", "hello"));
    expect(buildChatView(transition.state).queuedMessages.map((message) => message.id)).toEqual([
      "message-1",
    ]);
    expect(transition.effects).toEqual([]);

    transition = updateChat(transition.state, {
      type: "transportEvent",
      event: { type: "attached", snapshot: snapshot() },
    });
    const floor = transition.effects.find((effect) => effect.type === "readHistory");
    expect(floor).toMatchObject({ purpose: "floor" });

    transition = updateChat(transition.state, {
      type: "historyCompleted",
      id: floor && floor.type === "readHistory" ? floor.id : -1,
      purpose: "floor",
      history: [],
    });
    expect(buildChatView(transition.state)).toMatchObject({
      status: "submitted",
      queuedMessages: [],
      messages: [userMessage("message-1", "hello")],
    });
    expect(transition.effects).toContainEqual({
      type: "submitPrompt",
      messageId: "message-1",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("allows an authoritative empty reconciliation to clear a stale transcript", () => {
    const state: ChatState = {
      ...createChatState(),
      session: {
        ...createChatState().session,
        messages: [userMessage("stale", "stale")],
        historyStatus: "settled",
      },
      sync: {
        ...createChatState().sync,
        historyLoaded: true,
        needsReconcile: true,
        reconcile: { id: 7, promptRevision: 0 },
      },
    };

    const transition = updateChat(state, {
      type: "historyCompleted",
      id: 7,
      purpose: "reconcile",
      history: [],
    });

    expect(transition.state.session.messages).toEqual([]);
    expect(transition.state.sync.needsReconcile).toBe(false);
  });

  it("ignores stale history, prompt and fold completions", () => {
    const state = createChatState();
    expect(
      updateChat(state, {
        type: "historyCompleted",
        id: 99,
        purpose: "reconcile",
        history: [userMessage("late", "late")],
      }),
    ).toEqual({ state, effects: [] });
    expect(updateChat(state, { type: "promptCompleted", messageId: "late" })).toEqual({
      state,
      effects: [],
    });
    expect(
      updateChat(state, {
        type: "foldUpdated",
        turnId: "late",
        generation: 1,
        message: { id: "late", role: "assistant", parts: [] },
      }),
    ).toEqual({ state, effects: [] });
  });

  it("publishes the complete terminal shape in one transition and ignores later events", () => {
    let transition = updateChat(createChatState(), requested("queued", "later"));
    transition = updateChat(transition.state, {
      type: "transportEvent",
      event: { type: "closed", reason: "session_deleted" },
    });

    expect(buildChatView(transition.state)).toMatchObject({
      queuedMessages: [],
      pendingRequests: [],
      historyStatus: "settled",
      status: "error",
      error: new Error("Session deleted"),
    });
    const terminal = transition.state;
    expect(
      updateChat(terminal, {
        type: "foldUpdated",
        turnId: "late",
        generation: 1,
        message: { id: "late", role: "assistant", parts: [] },
      }),
    ).toEqual({ state: terminal, effects: [] });
  });
});
