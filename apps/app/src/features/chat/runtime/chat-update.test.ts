import type { SessionRuntimeSnapshot } from "@vibest/contract";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createChatState, type ChatState } from "./chat-state";
import { type ChatInput, updateChat } from "./chat-update";
import { deriveChatView } from "./chat-view";

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

const assistantMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
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

  it("returns the original state for stale sequenced and asynchronous inputs", () => {
    const expectIgnored = (state: ChatState, input: ChatInput): void => {
      const transition = updateChat(state, input);
      expect(transition.state).toBe(state);
      expect(transition.effects).toEqual([]);
    };

    const sequenced = createChatState();
    sequenced.sync.cursor = 10;
    expectIgnored(sequenced, {
      type: "transportEvent",
      event: {
        seq: 10,
        ref,
        type: "session.turn.started",
        turnId: "late",
        phase: "running",
      },
    });

    const flooring = createChatState();
    flooring.sync.floor = { id: 1, snapshot: snapshot(), events: [] };
    expectIgnored(flooring, {
      type: "historyCompleted",
      id: 99,
      purpose: "floor",
      history: [userMessage("late-floor", "late")],
    });

    const reconciling = createChatState();
    reconciling.sync.reconcile = { id: 2, promptRevision: 0 };
    expectIgnored(reconciling, {
      type: "historyCompleted",
      id: 99,
      purpose: "reconcile",
      history: [userMessage("late-reconcile", "late")],
    });

    const prompting = createChatState();
    const pending = requested("sending", "in flight");
    prompting.outgoing = [{ message: pending.message, parts: pending.parts, status: "sending" }];
    expectIgnored(prompting, { type: "promptCompleted", messageId: "late" });

    const folding = createChatState();
    folding.turns.folds.active = { generation: 3, status: "open" };
    expectIgnored(folding, {
      type: "foldUpdated",
      turnId: "active",
      generation: 2,
      message: assistantMessage("late-fold", "late"),
    });
    expectIgnored(folding, { type: "foldFinished", turnId: "active", generation: 2 });
  });

  it("updates a fold without mutating state or copying unrelated branches", () => {
    const initial = createChatState();
    const previous = assistantMessage("assistant-1", "partial");
    const state: ChatState = {
      ...initial,
      session: { ...initial.session, messages: [previous] },
      turns: {
        ...initial.turns,
        folds: { "turn-1": { generation: 4, status: "open" } },
      },
    };
    const before = structuredClone(state);
    const completed = assistantMessage("assistant-1", "complete");

    const transition = updateChat(state, {
      type: "foldUpdated",
      turnId: "turn-1",
      generation: 4,
      message: completed,
    });

    expect(state).toEqual(before);
    expect(transition.state).not.toBe(state);
    expect(transition.state.session).not.toBe(state.session);
    expect(transition.state.session.messages).not.toBe(state.session.messages);
    expect(transition.state.session.messages).toEqual([completed]);
    expect(transition.state.session.messages[0]).not.toBe(completed);
    expect(transition.state.session.pendingRequests).toBe(state.session.pendingRequests);
    expect(transition.state.outgoing).toBe(state.outgoing);
    expect(transition.state.lifecycle).toBe(state.lifecycle);
    expect(transition.state.sync).toBe(state.sync);
    expect(transition.state.prompt).toBe(state.prompt);
    expect(transition.state.turns).toBe(state.turns);
    expect(transition.state.pendingResponses).toBe(state.pendingResponses);
    expect(transition.effects).toEqual([]);
  });

  it("publishes the complete terminal shape in one transition and ignores later events", () => {
    let transition = updateChat(createChatState(), requested("queued", "later"));
    transition = updateChat(transition.state, {
      type: "transportEvent",
      event: { type: "closed", reason: "session_deleted" },
    });

    expect(deriveChatView(transition.state)).toMatchObject({
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
