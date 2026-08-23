import type { PermissionMode, ReasoningEffort, SessionRef } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import type { AgentResponse } from "./agent-requests";
import { ChatManager } from "./chat-manager";
import type { ChatSessionTransport, ChatTransportEvent } from "./chat-transport-port";

const refFor = (sessionId: string, overrides: Partial<SessionRef> = {}): SessionRef => ({
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId,
  ...overrides,
});

class FakeTransport implements ChatSessionTransport {
  onEvent: ((event: ChatTransportEvent) => void) | null = null;
  disposed = 0;

  subscribe(onEvent: (event: ChatTransportEvent) => void): () => void {
    this.onEvent = onEvent;
    return () => {
      this.disposed += 1;
    };
  }
  prompt = async () => ({ turnId: "turn-receipt" });
  getMessages = async () => null;
  respondToAgentRequest = async (_requestId: string, _response: AgentResponse) => {};
  setModel = async (_providerId: string, _modelId: string) => {};
  setReasoningEffort = async (_effort: ReasoningEffort) => {};
  setPermissionMode = async (_mode: PermissionMode) => {};
}

const makeManager = () => {
  const transports: FakeTransport[] = [];
  const manager = new ChatManager(() => {
    const transport = new FakeTransport();
    transports.push(transport);
    return transport;
  });
  return { manager, transports };
};

describe("ChatManager", () => {
  it("hands out one Chat per complete SessionRef across calls", () => {
    const { manager, transports } = makeManager();
    const first = manager.chatFor(refFor("session-1"));
    expect(manager.chatFor(refFor("session-1"))).toBe(first);
    expect(manager.chatFor(refFor("session-2"))).not.toBe(first);
    expect(manager.chatFor(refFor("session-1", { projectId: "project-2" }))).not.toBe(first);
    expect(transports).toHaveLength(3);
  });

  it("evicts and unsubscribes a Chat once the session closes", () => {
    const { manager, transports } = makeManager();
    const chat = manager.chatFor(refFor("session-1"));
    const transport = transports[0];

    transport?.onEvent?.({ type: "closed", reason: "session_closed" });

    expect(transport?.disposed).toBe(1);
    // The evicted instance keeps its terminal state for whoever is still
    // rendering it — eviction only stops it being handed out again.
    expect(chat.store.getState().error?.message).toBe("Session closed");
  });

  it("builds a fresh Chat when a closed session is opened again", () => {
    const { manager, transports } = makeManager();
    const closed = manager.chatFor(refFor("session-1"));
    transports[0]?.onEvent?.({ type: "closed", reason: "session_closed" });

    // What a restore looks like from here: the terminated instance is gone,
    // so the session gets a new Chat on its own new subscription rather than
    // the permanently-terminated one.
    const reopened = manager.chatFor(refFor("session-1"));
    expect(reopened).not.toBe(closed);
    expect(transports).toHaveLength(2);
    expect(reopened.store.getState().error).toBeUndefined();
  });

  it("evicts once even if the stream closes twice", () => {
    const { manager, transports } = makeManager();
    manager.chatFor(refFor("session-1"));
    const first = transports[0];
    first?.onEvent?.({ type: "closed", reason: "session_closed" });
    const reopened = manager.chatFor(refFor("session-1"));

    // A late duplicate from the dead subscription must not take the
    // replacement down with it.
    first?.onEvent?.({ type: "closed", reason: "session_deleted" });

    expect(manager.chatFor(refFor("session-1"))).toBe(reopened);
    expect(transports[1]?.disposed).toBe(0);
  });
});
