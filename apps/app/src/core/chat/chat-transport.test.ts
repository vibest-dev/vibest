import type { AgentRequest, SessionRuntimeSnapshot, SubscribeStreamEvent } from "@vibest/contract";
import type { UIMessage, UIMessageChunk } from "ai";
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

// Yields `items`, then hangs forever: the stream may only end through an
// explicit `return` in promptChunks, never by the iterable running dry — so a
// missing termination guard shows up as a test timeout, not a false pass.
const hangingIterableOf = (
  items: readonly SubscribeStreamEvent[],
): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: () => {
        const item = items[index];
        index += 1;
        if (item) return Promise.resolve({ done: false as const, value: item });
        return new Promise<never>(() => undefined);
      },
    };
  },
});

const userMessage: UIMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "hello" }],
};

const sendOptions = {
  trigger: "submit-message" as const,
  chatId: "chat-1",
  messageId: undefined,
  messages: [userMessage],
  abortSignal: undefined,
};

const readAll = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
};

describe("OrpcChatSessionTransport sendMessages recovery", () => {
  it("marks the turn started from a recovery snapshot with an empty buffer", async () => {
    // The subscription drops before any event arrives; the snapshot proves the
    // turn exists but has buffered nothing yet. `session.turn.started` is never
    // redelivered, so post-recovery chunks must still flow.
    let subscribeCalls = 0;
    const session = {
      getSnapshot: async (): Promise<SessionRuntimeSnapshot> => ({
        ref,
        status: { phase: "running", activeTurnId: "turn-1" },
        pendingRequests: [],
        activeTurn: { turnId: "turn-1", messageId: null, chunks: [], complete: false },
        cursor: 1,
      }),
      prompt: async () => ({ turnId: "turn-1" }),
      interrupt: unexpectedCall,
      respondToAgentRequest: unexpectedCall,
      subscribe: async () => {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          return hangingIterableOf([{ type: "closed", reason: "stream_replaced" }]);
        }
        return hangingIterableOf([
          {
            type: "event",
            event: {
              seq: 2,
              ref,
              type: "session.message.chunk",
              turnId: "turn-1",
              chunk: { type: "text-delta", id: "m1", delta: "hi" },
            },
          },
          {
            type: "event",
            event: {
              seq: 3,
              ref,
              type: "session.turn.ended",
              turnId: "turn-1",
              outcome: "completed",
            },
          },
        ]);
      },
    };
    const transport = new OrpcChatSessionTransport({ session } satisfies ChatTransportClient, ref);

    const chunks = await readAll(await transport.sendMessages(sendOptions));

    expect(subscribeCalls).toBe(2);
    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "hi" }]);
  });

  it("replays a completed retained buffer and terminates without further events", async () => {
    // The turn ended while we were disconnected: the snapshot's buffer is
    // marked complete. Replaying it must end the stream — waiting on the fresh
    // subscription would hang forever.
    let subscribeCalls = 0;
    const session = {
      getSnapshot: async (): Promise<SessionRuntimeSnapshot> => ({
        ref,
        status: { phase: "idle" },
        pendingRequests: [],
        activeTurn: {
          turnId: "turn-1",
          messageId: "m1",
          chunks: [
            {
              seq: 2,
              ref,
              type: "session.message.chunk",
              turnId: "turn-1",
              chunk: { type: "text-delta", id: "m1", delta: "tail" },
            },
          ],
          complete: true,
        },
        cursor: 3,
      }),
      prompt: async () => ({ turnId: "turn-1" }),
      interrupt: unexpectedCall,
      respondToAgentRequest: unexpectedCall,
      subscribe: async () => {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          return hangingIterableOf([{ type: "closed", reason: "stream_replaced" }]);
        }
        return hangingIterableOf([]);
      },
    };
    const transport = new OrpcChatSessionTransport({ session } satisfies ChatTransportClient, ref);

    const chunks = await readAll(await transport.sendMessages(sendOptions));

    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "tail" }]);
  });

  it("terminates on session.crashed even before turn.started arrived", async () => {
    // A crash before our turn started means the turn will never run; no other
    // event is coming, so the crash itself must end the stream.
    const session = {
      getSnapshot: unexpectedCall,
      prompt: async () => ({ turnId: "turn-1" }),
      interrupt: unexpectedCall,
      respondToAgentRequest: unexpectedCall,
      subscribe: async () =>
        hangingIterableOf([
          { type: "event", event: { seq: 1, ref, type: "session.crashed", reason: "boom" } },
        ]),
    };
    const transport = new OrpcChatSessionTransport({ session } satisfies ChatTransportClient, ref);

    const chunks = await readAll(await transport.sendMessages(sendOptions));

    expect(chunks).toEqual([]);
  });
});
