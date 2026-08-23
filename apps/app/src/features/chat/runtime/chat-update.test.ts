import type { SessionRuntimeSnapshot } from "@vibest/contract";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createChatState, type ChatState } from "./chat-state";
import { updateChat } from "./chat-update";

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
  acceptedPrompts: [],
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
  it("starts every user message as one queued follow-up", () => {
    const transition = updateChat(createChatState(), requested("message-1", "hello"));
    expect(transition.state.outgoing).toEqual([
      {
        message: userMessage("message-1", "hello"),
        parts: [{ type: "text", text: "hello" }],
        delivery: "follow-up",
        status: "queued",
      },
    ]);
    expect(transition.state.session.messages).toEqual([]);
  });

  it("keeps a follow-up queued until the history floor commits", () => {
    let transition = updateChat(createChatState(), requested("message-1", "hello"));
    transition = updateChat(transition.state, {
      type: "transportEvent",
      event: { type: "attached", snapshot: snapshot() },
    });
    const floor = transition.effects.find((effect) => effect.type === "readHistory");
    transition = updateChat(transition.state, {
      type: "historyCompleted",
      id: floor && floor.type === "readHistory" ? floor.id : -1,
      purpose: "floor",
      history: [],
    });
    expect(transition.state.session).toMatchObject({
      status: "submitted",
      messages: [userMessage("message-1", "hello")],
    });
    expect(transition.state.outgoing[0]).toMatchObject({
      delivery: "follow-up",
      status: "sending",
    });
    expect(transition.effects).toContainEqual({
      type: "submitPrompt",
      messageId: "message-1",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("changes only an existing queued follow-up into a steer", () => {
    const state: ChatState = {
      ...createChatState(),
      session: { ...createChatState().session, activeTurnId: "turn-1", status: "streaming" },
      outgoing: [
        {
          message: userMessage("message-1", "change direction"),
          parts: [{ type: "text", text: "change direction" }],
          delivery: "follow-up",
          status: "queued",
        },
      ],
    };
    const transition = updateChat(state, { type: "steerRequested", messageId: "message-1" });
    expect(transition.state.outgoing).toHaveLength(1);
    expect(transition.state.outgoing[0]).toMatchObject({
      message: userMessage("message-1", "change direction"),
      delivery: "steer",
      status: "sending",
      expectedTurnId: "turn-1",
    });
    expect(transition.effects).toEqual([
      {
        type: "submitSteer",
        expectedTurnId: "turn-1",
        messageId: "message-1",
        parts: [{ type: "text", text: "change direction" }],
      },
    ]);
    expect(updateChat(state, { type: "steerRequested", messageId: "missing" })).toEqual({
      state,
      effects: [],
    });
  });

  it("keeps follow-up waiting while dispatching steer during an active turn", () => {
    const state: ChatState = {
      ...createChatState(),
      session: { ...createChatState().session, activeTurnId: "turn-1", status: "streaming" },
      sync: { ...createChatState().sync, historyLoaded: true },
      outgoing: [
        {
          message: userMessage("follow", "afterwards"),
          parts: [{ type: "text", text: "afterwards" }],
          delivery: "follow-up",
          status: "queued",
        },
        {
          message: userMessage("steer", "now"),
          parts: [{ type: "text", text: "now" }],
          delivery: "steer",
          status: "queued",
          expectedTurnId: "turn-1",
        },
      ],
    };
    const transition = updateChat(state, {
      type: "transportEvent",
      event: {
        seq: 1,
        ref,
        type: "session.message.chunk",
        turnId: "turn-1",
        chunk: { type: "text-start", id: "x" },
      },
    });
    expect(transition.effects).toContainEqual({
      type: "submitSteer",
      expectedTurnId: "turn-1",
      messageId: "steer",
      parts: [{ type: "text", text: "now" }],
    });
    expect(transition.effects.some((effect) => effect.type === "submitPrompt")).toBe(false);
    expect(
      transition.state.outgoing.find((message) => message.message.id === "follow")?.status,
    ).toBe("queued");
  });

  it("marks a stale or failed steer explicitly and never converts it to follow-up", () => {
    const state: ChatState = {
      ...createChatState(),
      session: { ...createChatState().session, activeTurnId: "turn-2", status: "streaming" },
      outgoing: [
        {
          message: userMessage("steer", "now"),
          parts: [{ type: "text", text: "now" }],
          delivery: "steer",
          status: "queued",
          expectedTurnId: "turn-1",
        },
      ],
    };
    const stale = updateChat(state, {
      type: "transportEvent",
      event: {
        seq: 1,
        ref,
        type: "session.message.chunk",
        turnId: "turn-2",
        chunk: { type: "text-start", id: "x" },
      },
    });
    expect(stale.effects).toContainEqual({
      type: "rejectPrompt",
      messageId: "steer",
      error: new Error("The turn selected for steering is no longer active"),
    });
    expect(stale.effects.some((effect) => effect.type === "submitPrompt")).toBe(false);
    expect(stale.state.outgoing[0]).toMatchObject({ delivery: "steer", status: "failed" });

    const sending: ChatState = {
      ...state,
      outgoing: [{ ...state.outgoing[0]!, expectedTurnId: "turn-2", status: "sending" }],
    };
    const failed = updateChat(sending, {
      type: "outgoingCompleted",
      messageId: "steer",
      delivery: "steer",
      error: new Error("turn changed"),
    });
    expect(failed.state.outgoing[0]).toMatchObject({ delivery: "steer", status: "failed" });
    expect(failed.effects).toEqual([
      { type: "rejectPrompt", messageId: "steer", error: new Error("turn changed") },
    ]);
  });

  it("keeps only the new Pi assistant segment after a steered continuation", () => {
    const state: ChatState = {
      ...createChatState(),
      session: {
        ...createChatState().session,
        messages: [
          {
            id: "segment-0",
            role: "assistant",
            metadata: { sessionId: "pi-session", runId: "run-1", segment: 0 },
            parts: [{ type: "text", text: "before" }],
          },
        ],
      },
      turns: {
        ...createChatState().turns,
        folds: { "turn-1": { generation: 1, status: "open" } },
      },
    };
    const transition = updateChat(state, {
      type: "foldUpdated",
      turnId: "turn-1",
      generation: 1,
      message: {
        id: "segment-1",
        role: "assistant",
        metadata: { sessionId: "pi-session", runId: "run-1", segment: 1 },
        parts: [
          { type: "text", text: "before" },
          { type: "text", text: "after" },
        ],
      },
    });
    expect(transition.state.session.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "before" }],
      [{ type: "text", text: "after" }],
    ]);
  });

  it("trims the full cumulative prefix after multiple Pi steers in one run", () => {
    const base = createChatState();
    const state: ChatState = {
      ...base,
      session: {
        ...base.session,
        messages: [
          {
            id: "segment-0",
            role: "assistant",
            metadata: { runId: "run-1", segment: 0 },
            parts: [{ type: "text", text: "before" }],
          },
          {
            id: "segment-1",
            role: "assistant",
            metadata: { runId: "run-1", segment: 1 },
            parts: [{ type: "text", text: "after" }],
          },
          {
            id: "old-turn",
            role: "assistant",
            metadata: { runId: "old-run", segment: 0 },
            parts: [{ type: "text", text: "unrelated" }],
          },
        ],
      },
      turns: {
        ...base.turns,
        folds: { "turn-1": { generation: 1, status: "open" } },
      },
    };
    const transition = updateChat(state, {
      type: "foldUpdated",
      turnId: "turn-1",
      generation: 1,
      message: {
        id: "segment-2",
        role: "assistant",
        metadata: { runId: "run-1", segment: 2 },
        parts: [
          { type: "text", text: "before" },
          { type: "text", text: "after" },
          { type: "text", text: "third" },
        ],
      },
    });
    expect(transition.state.session.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "third" },
    ]);
  });

  it("does not over-trim repeated updates for the current Pi segment", () => {
    const base = createChatState();
    const state: ChatState = {
      ...base,
      session: {
        ...base.session,
        messages: [
          {
            id: "segment-0",
            role: "assistant",
            metadata: { runId: "run-1", segment: 0 },
            parts: [{ type: "text", text: "before" }],
          },
          {
            id: "segment-1",
            role: "assistant",
            metadata: { runId: "run-1", segment: 1 },
            parts: [{ type: "text", text: "after" }],
          },
        ],
      },
      turns: {
        ...base.turns,
        folds: { "turn-1": { generation: 1, status: "open" } },
      },
    };
    const transition = updateChat(state, {
      type: "foldUpdated",
      turnId: "turn-1",
      generation: 1,
      message: {
        id: "segment-1",
        role: "assistant",
        metadata: { runId: "run-1", segment: 1 },
        parts: [
          { type: "text", text: "before" },
          { type: "text", text: "after updated" },
        ],
      },
    });
    expect(transition.state.session.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "after updated" },
    ]);
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
});
