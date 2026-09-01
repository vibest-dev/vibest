import { ORPCError } from "@orpc/client";
import type { SessionRuntimeSnapshot, SubscribeStreamEvent } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { OrpcChatSessionTransport, type ChatTransportClient } from "./chat-transport";
import type { ChatTransportEvent } from "./chat-transport-port";

const ref = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
} as const;

const snapshot: SessionRuntimeSnapshot = {
  ref,
  streamId: "stream-1",
  status: { phase: "idle" },
  recovery: null,
  activeTurn: null,
  activePrompt: null,
  acceptedPrompt: null,
  acceptedPrompts: [],
  pendingPrompts: [],
  pendingRequests: [],
  cursor: 0,
};

const unexpectedCall = async (): Promise<never> => {
  throw new Error("Unexpected transport call");
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

// Yields `items`, then stays open (pending forever) — the subscription
// survives until unsubscribe aborts it, letting a test assert on a recovered
// stream without the recovery loop spinning further.
const hangingIterableOf = (
  items: readonly SubscribeStreamEvent[],
  onDrained: () => void = () => undefined,
): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: () => {
        const item = items[index];
        index += 1;
        if (item) return Promise.resolve({ done: false as const, value: item });
        onDrained();
        return new Promise<never>(() => undefined);
      },
    };
  },
});

const throwingIterable = (): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        throw new Error("connection reset");
      },
    };
  },
});

const baseSession = {
  getSnapshot: async () => snapshot,
  prompt: unexpectedCall,
  steer: unexpectedCall,
  setModel: unexpectedCall,
  setReasoningEffort: unexpectedCall,
  setPermissionMode: unexpectedCall,
  getMessages: unexpectedCall,
  respondToAgentRequest: unexpectedCall,
  subscribe: unexpectedCall,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OrpcChatSessionTransport subscription", () => {
  it("emits attached (subscription first, then snapshot) and forwards session-scoped events", async () => {
    let finishStream: () => void = () => undefined;
    const streamDone = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    let subscriptionCalls = 0;
    let snapshotSawSubscription = false;
    const items: SubscribeStreamEvent[] = [
      {
        type: "event",
        event: {
          streamId: "stream-1",
          seq: 1,
          ref,
          type: "session.turn.started",
          turnId: "turn-1",
        },
      },
      // Collection events ride the same stream but are not session-scoped.
      { type: "event", event: { ref, type: "session.updated", title: "t" } },
      {
        type: "event",
        event: {
          streamId: "stream-1",
          seq: 2,
          ref,
          type: "session.turn.ended",
          outcome: "completed",
          turnId: "turn-1",
        },
      },
    ];
    const client = {
      session: {
        ...baseSession,
        getSnapshot: async () => {
          snapshotSawSubscription = subscriptionCalls === 1;
          return snapshot;
        },
        subscribe: async () => {
          subscriptionCalls += 1;
          return asyncIterableOf(items, finishStream);
        },
      },
    } satisfies ChatTransportClient;
    const received: ChatTransportEvent[] = [];
    const transport = new OrpcChatSessionTransport(client, ref);
    const unsubscribe = transport.subscribe((event) => received.push(event));
    await streamDone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshotSawSubscription).toBe(true);
    expect(received.map((event) => event.type)).toEqual([
      "attached",
      "session.turn.started",
      "session.turn.ended",
    ]);
    unsubscribe();
  });

  it("re-attaches after a server-side drop", async () => {
    let drained: () => void = () => undefined;
    const secondDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    let subscriptionCalls = 0;
    const client = {
      session: {
        ...baseSession,
        subscribe: async () => {
          subscriptionCalls += 1;
          return subscriptionCalls === 1
            ? asyncIterableOf([{ type: "closed", reason: "slow_consumer" }])
            : hangingIterableOf(
                [
                  {
                    type: "event",
                    event: {
                      streamId: "stream-1",
                      seq: 5,
                      ref,
                      type: "session.turn.started",
                      turnId: "turn-2",
                    },
                  },
                ],
                drained,
              );
        },
      },
    } satisfies ChatTransportClient;
    const received: ChatTransportEvent[] = [];
    const transport = new OrpcChatSessionTransport(client, ref, { retryDelayMs: () => 0 });
    const unsubscribe = transport.subscribe((event) => received.push(event));
    await secondDrained;
    await flush();
    expect(subscriptionCalls).toBe(2);
    expect(received.map((event) => event.type)).toEqual([
      "attached",
      "attached",
      "session.turn.started",
    ]);
    unsubscribe();
  });

  it("recovers when the stream ends without a closed event", async () => {
    let drained: () => void = () => undefined;
    const secondDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    let subscriptionCalls = 0;
    const client = {
      session: {
        ...baseSession,
        subscribe: async () => {
          subscriptionCalls += 1;
          return subscriptionCalls === 1 ? asyncIterableOf([]) : hangingIterableOf([], drained);
        },
      },
    } satisfies ChatTransportClient;
    const received: ChatTransportEvent[] = [];
    const transport = new OrpcChatSessionTransport(client, ref, { retryDelayMs: () => 0 });
    const unsubscribe = transport.subscribe((event) => received.push(event));
    await secondDrained;
    await flush();
    expect(received.filter((event) => event.type === "attached")).toHaveLength(2);
    unsubscribe();
  });

  it("re-subscribes after the event iterator throws (network blip)", async () => {
    let drained: () => void = () => undefined;
    const recoveredDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    let subscriptionCalls = 0;
    const client = {
      session: {
        ...baseSession,
        subscribe: async () => {
          subscriptionCalls += 1;
          return subscriptionCalls === 1 ? throwingIterable() : hangingIterableOf([], drained);
        },
      },
    } satisfies ChatTransportClient;
    const received: ChatTransportEvent[] = [];
    const transport = new OrpcChatSessionTransport(client, ref, { retryDelayMs: () => 0 });
    const unsubscribe = transport.subscribe((event) => received.push(event));
    await recoveredDrained;
    await flush();
    expect(subscriptionCalls).toBe(2);
    expect(received.filter((event) => event.type === "attached")).toHaveLength(2);
    unsubscribe();
  });

  it("keeps retrying when the attach snapshot read fails", async () => {
    let drained: () => void = () => undefined;
    const recoveredDrained = new Promise<void>((resolve) => {
      drained = resolve;
    });
    let snapshotCalls = 0;
    const client = {
      session: {
        ...baseSession,
        getSnapshot: async () => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) throw new Error("rpc failed");
          return snapshot;
        },
        // subscribe runs before each getSnapshot: the first call sees 0 failed
        // reads, the recovery call sees 1 — only the latter signals drained.
        subscribe: async () =>
          hangingIterableOf([], snapshotCalls >= 1 ? drained : () => undefined),
      },
    } satisfies ChatTransportClient;
    const received: ChatTransportEvent[] = [];
    const transport = new OrpcChatSessionTransport(client, ref, { retryDelayMs: () => 0 });
    const unsubscribe = transport.subscribe((event) => received.push(event));
    await recoveredDrained;
    await flush();
    expect(received.some((event) => event.type === "attached")).toBe(true);
    unsubscribe();
  });
});

describe("OrpcChatSessionTransport RPC mapping", () => {
  it("forwards abort signals as the oRPC call options", async () => {
    const calls: Array<{ name: string; options: unknown }> = [];
    const record = (name: string, options: unknown) => calls.push({ name, options });
    const client = {
      session: {
        ...baseSession,
        prompt: async (_input: unknown, options?: unknown) => {
          record("prompt", options);
          return { turnId: "turn-1" };
        },
        getMessages: async (_input: unknown, options?: unknown) => {
          record("getMessages", options);
          return { messages: [] };
        },
        acknowledgeRecovery: async (_input: unknown, options?: unknown) => {
          record("acknowledgeRecovery", options);
        },
        respondToAgentRequest: async (_input: unknown, options?: unknown) => {
          record("respondToAgentRequest", options);
        },
        setModel: async (_input: unknown, options?: unknown) => {
          record("setModel", options);
        },
        setReasoningEffort: async (_input: unknown, options?: unknown) => {
          record("setReasoningEffort", options);
        },
        setPermissionMode: async (_input: unknown, options?: unknown) => {
          record("setPermissionMode", options);
        },
      },
    } satisfies ChatTransportClient;
    const transport = new OrpcChatSessionTransport(client, ref);
    const signal = new AbortController().signal;

    await transport.prompt(
      { messageId: "message-1", parts: [{ type: "text", text: "hi" }] },
      { signal },
    );
    await transport.getMessages({ signal });
    await transport.acknowledgeRecovery("recovery-1", { signal });
    await transport.respondToAgentRequest(
      "request-1",
      { type: "tool", behavior: "allow" },
      { signal },
    );
    await transport.setModel("provider", "model", { signal });
    await transport.setReasoningEffort("high", { signal });
    await transport.setPermissionMode("ask", { signal });

    expect(calls.map((call) => call.name)).toEqual([
      "prompt",
      "getMessages",
      "acknowledgeRecovery",
      "respondToAgentRequest",
      "setModel",
      "setReasoningEffort",
      "setPermissionMode",
    ]);
    expect(calls.map((call) => call.options)).toEqual(
      Array.from({ length: 7 }, () => ({ signal })),
    );
  });

  it("maps UNSUPPORTED history to null (capability absence, not failure)", async () => {
    const client = {
      session: {
        ...baseSession,
        getMessages: async (): Promise<never> => {
          throw new ORPCError("UNSUPPORTED");
        },
      },
    } satisfies ChatTransportClient;
    const transport = new OrpcChatSessionTransport(client, ref);
    expect(await transport.getMessages()).toBeNull();
  });

  it("treats NOT_FOUND on respond as resolution (another client answered first)", async () => {
    const client = {
      session: {
        ...baseSession,
        respondToAgentRequest: async (): Promise<never> => {
          throw new ORPCError("NOT_FOUND");
        },
      },
    } satisfies ChatTransportClient;
    const transport = new OrpcChatSessionTransport(client, ref);
    await expect(
      transport.respondToAgentRequest("request-1", { type: "tool", behavior: "allow" }),
    ).resolves.toBeUndefined();
  });

  it("submits prompts fire-and-forget with the optimistic message id", async () => {
    const calls: unknown[] = [];
    const client = {
      session: {
        ...baseSession,
        prompt: async (input: unknown) => {
          calls.push(input);
          return { turnId: "turn-9" };
        },
      },
    } satisfies ChatTransportClient;
    const transport = new OrpcChatSessionTransport(client, ref);
    const receipt = await transport.prompt({
      messageId: "message-1",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(receipt.turnId).toBe("turn-9");
    expect(calls).toEqual([{ ref, parts: [{ type: "text", text: "hi" }], messageId: "message-1" }]);
  });
});
