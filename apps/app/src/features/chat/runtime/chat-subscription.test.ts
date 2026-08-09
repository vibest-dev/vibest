import type { SessionRuntimeSnapshot, SubscribeStreamEvent } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { RecoveringSubscription } from "./chat-subscription";

const snapshot: SessionRuntimeSnapshot = {
  ref: {
    projectId: "project-1",
    harnessAgentId: "claude-code",
    sessionId: "session-1",
  },
  status: { phase: "idle" },
  activeTurn: null,
  activePrompt: null,
  acceptedPrompt: null,
  pendingPrompts: [],
  pendingRequests: [],
  cursor: 0,
};

// Ends immediately: each attach cycle pumps zero events and exits naturally,
// driving the recovery loop around as fast as retryDelayMs allows.
const endingIterable = (): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true as const, value: undefined }),
  }),
});

// Never yields: the cycle stays parked in the pump until aborted.
const hangingIterable = (): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<never>(() => undefined),
  }),
});

// Yields the given items, then ends.
const iterableOf = (
  items: readonly SubscribeStreamEvent[],
): AsyncIterable<SubscribeStreamEvent> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: async () => {
        const item = items[index];
        index += 1;
        return item
          ? { done: false as const, value: item }
          : { done: true as const, value: undefined };
      },
    };
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RecoveringSubscription", () => {
  it("start() is idempotent — a second call opens no second stream", async () => {
    let opens = 0;
    const subscription = new RecoveringSubscription({
      subscribe: async () => {
        opens += 1;
        return hangingIterable();
      },
      getSnapshot: async () => snapshot,
      onEvent: () => undefined,
      retryDelayMs: () => 0,
    });
    subscription.start();
    subscription.start();
    await flush();
    expect(opens).toBe(1);
    subscription.stop();
  });

  it("recovers from a slow_consumer close without surfacing it", async () => {
    let opens = 0;
    const events: string[] = [];
    const subscription = new RecoveringSubscription({
      subscribe: async () => {
        opens += 1;
        return opens === 1
          ? iterableOf([{ type: "closed", reason: "slow_consumer" }])
          : hangingIterable();
      },
      getSnapshot: async () => snapshot,
      onEvent: (event) => events.push(event.type),
      retryDelayMs: () => 0,
    });
    subscription.start();
    await expect.poll(() => opens).toBeGreaterThanOrEqual(2);
    expect(events).not.toContain("closed");
    subscription.stop();
  });

  it("keeps retrying repeated attach failures until it is stopped", async () => {
    let opens = 0;
    const subscription = new RecoveringSubscription({
      subscribe: async () => {
        opens += 1;
        if (opens < 25) throw new DOMException("socket unavailable", "AbortError");
        return hangingIterable();
      },
      getSnapshot: async () => snapshot,
      onEvent: () => undefined,
      retryDelayMs: () => 0,
    });
    subscription.start();

    await expect.poll(() => opens).toBe(25);
    subscription.stop();
  });

  it("stops for good on session_closed and surfaces it exactly once", async () => {
    let opens = 0;
    const events: string[] = [];
    const subscription = new RecoveringSubscription({
      subscribe: async () => {
        opens += 1;
        return iterableOf([{ type: "closed", reason: "session_closed" }]);
      },
      getSnapshot: async () => snapshot,
      onEvent: (event) => events.push(event.type),
      retryDelayMs: () => 0,
    });
    subscription.start();
    while (!events.includes("closed")) await flush();
    // Give the loop every chance to (wrongly) come around again.
    for (let i = 0; i < 5; i += 1) await flush();
    expect(opens).toBe(1);
    expect(events.filter((type) => type === "closed")).toHaveLength(1);
    subscription.stop();
  });

  it("never overlaps cycles: each stream is closed before the next opens", async () => {
    const timeline: string[] = [];
    const subscription = new RecoveringSubscription({
      subscribe: async (signal) => {
        timeline.push("open");
        signal.addEventListener("abort", () => timeline.push("close"), { once: true });
        return endingIterable();
      },
      getSnapshot: async () => snapshot,
      onEvent: () => undefined,
      retryDelayMs: () => 0,
    });
    subscription.start();
    while (timeline.filter((entry) => entry === "open").length < 3) await flush();
    subscription.stop();

    const reopensWithoutClose = timeline.filter(
      (entry, index) => entry === "open" && index > 0 && timeline[index - 1] !== "close",
    );
    expect(reopensWithoutClose).toEqual([]);
  });
});
