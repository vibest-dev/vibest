import type { AgentRequest, SessionRuntimeSnapshot, SubscribeStreamEvent } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { OrpcChatSessionTransport, type ChatTransportClient } from "./chat-transport";

const ref = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
} as const;

const pendingRequest: AgentRequest = {
  type: "tool",
  id: "request-1",
  harnessAgentId: "claude-code",
  toolName: "Bash",
  input: { command: "pwd" },
  actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
  native: null,
};

const snapshot: SessionRuntimeSnapshot = {
  ref,
  status: { phase: "requires_action" },
  activeTurn: null,
  pendingRequests: [pendingRequest],
  cursor: 7,
};

const emptyPlanRequest: AgentRequest = {
  type: "plan",
  id: "empty-plan",
  harnessAgentId: "claude-code",
  plan: "",
  native: null,
};

const asyncIterableOf = (
  items: readonly SubscribeStreamEvent[],
  onDone: () => void = () => undefined,
): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: async () => {
        const item = items[index];
        index += 1;
        if (item) return { done: false as const, value: item };
        onDone();
        return { done: true as const, value: undefined };
      },
    };
  },
});

const unexpectedCall = async (): Promise<never> => {
  throw new Error("Unexpected transport call");
};

describe("OrpcChatSessionTransport agent requests", () => {
  it("hydrates pending requests from the initial session snapshot", async () => {
    let finishStream: () => void = () => undefined;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    let subscriptionCalls = 0;
    let snapshotCalls = 0;
    let snapshotSawSubscription = false;
    const items: SubscribeStreamEvent[] = [
      {
        type: "event",
        event: { seq: 7, ref, type: "session.request.asked", request: pendingRequest },
      },
      {
        type: "event",
        event: { seq: 8, ref, type: "session.request.replied", requestId: pendingRequest.id },
      },
    ];
    const session = {
      getSnapshot: async () => {
        snapshotCalls += 1;
        snapshotSawSubscription = subscriptionCalls === 1;
        return snapshot;
      },
      prompt: unexpectedCall,
      interrupt: unexpectedCall,
      respondToAgentRequest: unexpectedCall,
      subscribe: async () => {
        subscriptionCalls += 1;
        // Resolve the test once the stream is fully drained.
        return asyncIterableOf(items, finishStream);
      },
    };
    const client = { session } satisfies ChatTransportClient;
    let deliveries = 0;
    const received: AgentRequest[] = [];
    const transport = new OrpcChatSessionTransport(client, ref);

    const unsubscribe = transport.subscribeAgentRequests(
      (request) => {
        deliveries += 1;
        received.push(request);
      },
      (requestId) => {
        const index = received.findIndex((request) => request.id === requestId);
        if (index >= 0) received.splice(index, 1);
      },
    );
    await streamDone;
    // Allow the drained stream's request handling to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(subscriptionCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
    expect(snapshotSawSubscription).toBe(true);
    expect(deliveries).toBe(1);
    expect(received).toEqual([]);
  });

  it("keeps listening when a resolved empty plan rejects its automatic response", async () => {
    let rejectAutomaticResponse: (error: Error) => void = () => undefined;
    const automaticResponse = new Promise<never>((_resolve, reject) => {
      rejectAutomaticResponse = reject;
    });
    let finishStream: () => void = () => undefined;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    const items: SubscribeStreamEvent[] = [
      {
        type: "event",
        event: { seq: 8, ref, type: "session.request.replied", requestId: emptyPlanRequest.id },
      },
      {
        type: "event",
        event: { seq: 9, ref, type: "session.request.asked", request: pendingRequest },
      },
    ];
    const session = {
      getSnapshot: async (): Promise<SessionRuntimeSnapshot> => ({
        ...snapshot,
        pendingRequests: [emptyPlanRequest],
      }),
      prompt: unexpectedCall,
      interrupt: unexpectedCall,
      respondToAgentRequest: async () => automaticResponse,
      subscribe: async () => asyncIterableOf(items, finishStream),
    };
    const client = { session } satisfies ChatTransportClient;
    const received: AgentRequest[] = [];
    const transport = new OrpcChatSessionTransport(client, ref);

    const unsubscribe = transport.subscribeAgentRequests(
      (request) => received.push(request),
      (requestId) => {
        const index = received.findIndex((request) => request.id === requestId);
        if (index >= 0) received.splice(index, 1);
      },
    );
    await streamDone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectAutomaticResponse(new Error("request already resolved"));
    await Promise.resolve();
    unsubscribe();

    expect(received).toEqual([pendingRequest]);
  });
});
