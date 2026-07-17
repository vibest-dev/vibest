import type { AgentRequest, SessionSnapshot } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { OrpcChatSessionTransport, type ChatTransportClient } from "./chat-transport";

const pendingRequest: AgentRequest = {
  type: "tool",
  id: "request-1",
  harnessAgentId: "claude-code",
  toolName: "Bash",
  input: { command: "pwd" },
  actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
  native: null,
};

const snapshot: SessionSnapshot = {
  history: [],
  activeTurn: null,
  pendingRequests: [pendingRequest],
  cursor: 7,
  degraded: false,
  bootId: "boot-1",
};

const emptyPlanRequest: AgentRequest = {
  type: "plan",
  id: "empty-plan",
  harnessAgentId: "claude-code",
  plan: "",
  native: null,
};

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
    const session = {
      snapshot: async () => {
        snapshotCalls += 1;
        snapshotSawSubscription = subscriptionCalls === 1;
        return snapshot;
      },
      prompt: unexpectedCall,
      interrupt: unexpectedCall,
      respondToAgentRequest: unexpectedCall,
      events: async () => {
        subscriptionCalls += 1;
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            const items = [
              {
                type: "event" as const,
                event: {
                  harnessAgentId: "claude-code" as const,
                  sessionId: "session-1",
                  seq: snapshot.cursor,
                  body: {
                    type: "session.request.asked" as const,
                    sessionId: "session-1",
                    request: pendingRequest,
                  },
                },
              },
              {
                type: "event" as const,
                event: {
                  harnessAgentId: "claude-code" as const,
                  sessionId: "session-1",
                  seq: snapshot.cursor + 1,
                  body: {
                    type: "session.request.replied" as const,
                    sessionId: "session-1",
                    requestId: pendingRequest.id,
                  },
                },
              },
            ];
            return {
              next: async () => {
                const item = items[index];
                index += 1;
                if (item) return { done: false as const, value: item };
                finishStream();
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    const client = { session } satisfies ChatTransportClient;
    let deliveries = 0;
    const received: AgentRequest[] = [];
    const transport = new OrpcChatSessionTransport(client);

    const unsubscribe = transport.subscribeAgentRequests(
      "session-1",
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
    unsubscribe();

    expect(subscriptionCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
    expect(snapshotSawSubscription).toBe(true);
    expect(deliveries).toBe(1);
    expect(received).toEqual([]);
  });

  it("keeps listening when a resolved empty plan rejects its automatic response", async () => {
    let finishStream: () => void = () => undefined;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    let rejectAutomaticResponse: (error: Error) => void = () => undefined;
    const automaticResponse = new Promise<never>((_resolve, reject) => {
      rejectAutomaticResponse = reject;
    });
    const session = {
      snapshot: async (): Promise<SessionSnapshot> => ({
        ...snapshot,
        pendingRequests: [emptyPlanRequest],
      }),
      prompt: unexpectedCall,
      interrupt: unexpectedCall,
      respondToAgentRequest: async () => automaticResponse,
      events: async () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          const items = [
            {
              type: "event" as const,
              event: {
                harnessAgentId: "claude-code" as const,
                sessionId: "session-1",
                seq: snapshot.cursor + 1,
                body: {
                  type: "session.request.replied" as const,
                  sessionId: "session-1",
                  requestId: emptyPlanRequest.id,
                },
              },
            },
            {
              type: "event" as const,
              event: {
                harnessAgentId: "claude-code" as const,
                sessionId: "session-1",
                seq: snapshot.cursor + 2,
                body: {
                  type: "session.request.asked" as const,
                  sessionId: "session-1",
                  request: pendingRequest,
                },
              },
            },
          ];
          return {
            next: async () => {
              const item = items[index];
              index += 1;
              if (item) return { done: false as const, value: item };
              finishStream();
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    };
    const client = { session } satisfies ChatTransportClient;
    const received: AgentRequest[] = [];
    const transport = new OrpcChatSessionTransport(client);

    const unsubscribe = transport.subscribeAgentRequests(
      "session-1",
      (request) => received.push(request),
      (requestId) => {
        const index = received.findIndex((request) => request.id === requestId);
        if (index >= 0) received.splice(index, 1);
      },
    );
    await streamDone;
    rejectAutomaticResponse(new Error("request already resolved"));
    await Promise.resolve();
    unsubscribe();

    expect(received).toEqual([pendingRequest]);
  });
});
