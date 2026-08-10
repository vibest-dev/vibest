import type { PromptPart } from "@vibest/contract";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { AgentRequest } from "./agent-requests";
import { createChatState, type ChatState } from "./chat-state";
import { firstQueuedMessage, hasMessage, hasSendingMessage, updateChat } from "./chat-update";
import { buildChatView } from "./chat-view";

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const parts = (text: string): PromptPart[] => [{ type: "text", text }];

describe("Chat state updates", () => {
  it("builds the initial Chat view", () => {
    expect(buildChatView(createChatState())).toEqual({
      messages: [],
      queuedMessages: [],
      status: "ready",
      error: undefined,
      pendingRequests: [],
      historyStatus: "loading",
    });
  });

  it("keeps outgoing messages FIFO while hiding the sending item from the queue view", () => {
    let state = createChatState();
    state = updateChat(state, {
      type: "messageQueued",
      message: userMessage("a", "A"),
      parts: parts("A"),
    });
    state = updateChat(state, {
      type: "messageQueued",
      message: userMessage("b", "B"),
      parts: parts("B"),
    });

    expect(firstQueuedMessage(state)?.message.id).toBe("a");
    expect(buildChatView(state).queuedMessages.map((message) => message.id)).toEqual(["a", "b"]);

    state = updateChat(state, { type: "messageSubmissionStarted", messageId: "a" });
    expect(hasSendingMessage(state)).toBe(true);
    expect(buildChatView(state).queuedMessages.map((message) => message.id)).toEqual(["b"]);
    expect(state.session.messages.map((message) => message.id)).toEqual(["a"]);

    state = updateChat(state, { type: "messageSubmissionFinished", messageId: "a" });
    expect(hasSendingMessage(state)).toBe(false);
    expect(firstQueuedMessage(state)?.message.id).toBe("b");
  });

  it("does not let a history replacement erase outgoing messages", () => {
    let state = createChatState();
    state = updateChat(state, {
      type: "messageQueued",
      message: userMessage("queued", "later"),
      parts: parts("later"),
    });
    state = updateChat(state, {
      type: "historyReadFinished",
      history: [userMessage("settled", "before")],
      replaceMessages: true,
    });

    expect(state.session.messages.map((message) => message.id)).toEqual(["settled"]);
    expect(buildChatView(state).queuedMessages.map((message) => message.id)).toEqual(["queued"]);
    expect(state.session.historyStatus).toBe("settled");
  });

  it("deduplicates user messages and only clears an error for an unseen message", () => {
    const existing = userMessage("same", "same");
    let state: ChatState = {
      ...createChatState([existing]),
      error: new Error("newer failure"),
    };

    state = updateChat(state, { type: "userMessageReceived", message: existing });
    expect(state.error?.message).toBe("newer failure");

    state = updateChat(state, {
      type: "userMessageReceived",
      message: userMessage("remote", "remote"),
    });
    expect(state.error).toBeUndefined();
    expect(hasMessage(state, "remote")).toBe(true);
  });

  it("upserts assistant snapshots with fresh message and parts identities", () => {
    const first: UIMessage = {
      id: "assistant",
      role: "assistant",
      parts: [{ type: "text", text: "one" }],
    };
    let state = updateChat(createChatState(), {
      type: "assistantMessageUpdated",
      message: first,
    });
    const storedFirst = state.session.messages[0]!;
    expect(storedFirst).not.toBe(first);
    expect(storedFirst.parts).not.toBe(first.parts);

    const second: UIMessage = {
      id: "assistant",
      role: "assistant",
      parts: [{ type: "text", text: "two" }],
    };
    state = updateChat(state, { type: "assistantMessageUpdated", message: second });
    expect(state.session.messages).toHaveLength(1);
    expect(state.session.messages[0]?.parts).toEqual(second.parts);
    expect(state.session.messages[0]).not.toBe(storedFirst);
  });

  it("adds, replaces, removes, and clears pending requests by id", () => {
    const first: AgentRequest = {
      type: "plan",
      id: "request",
      harnessAgentId: "claude-code",
      plan: "first",
      native: null,
    };
    const replacement = { ...first, plan: "replacement" };
    let state = updateChat(createChatState(), { type: "requestAdded", request: first });
    state = updateChat(state, { type: "requestAdded", request: replacement });
    expect(state.session.pendingRequests).toEqual([replacement]);

    state = updateChat(state, { type: "requestRemoved", requestId: first.id });
    expect(state.session.pendingRequests).toEqual([]);

    state = updateChat(state, { type: "requestAdded", request: first });
    state = updateChat(state, { type: "requestsCleared" });
    expect(state.session.pendingRequests).toEqual([]);
  });

  it("atomically terminates the view and ignores late updates", () => {
    let state = updateChat(createChatState(), {
      type: "messageQueued",
      message: userMessage("queued", "later"),
      parts: parts("later"),
    });
    const terminalError = new Error("Session closed");
    state = updateChat(state, { type: "sessionTerminated", error: terminalError });

    expect(buildChatView(state)).toMatchObject({
      queuedMessages: [],
      pendingRequests: [],
      historyStatus: "settled",
      status: "error",
      error: terminalError,
    });

    const late = updateChat(state, {
      type: "assistantMessageUpdated",
      message: { id: "late", role: "assistant", parts: [{ type: "text", text: "late" }] },
    });
    expect(late).toBe(state);
  });
});
