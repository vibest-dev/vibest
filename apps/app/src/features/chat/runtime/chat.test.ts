import type {
  AgentRequest,
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionMessageChunkEvent,
  SessionPhase,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
} from "@vibest/contract";
import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import type { AgentResponse } from "./agent-requests";
import { Chat } from "./chat";
import type { ChatSessionTransport, ChatTransportEvent } from "./chat-transport-port";

const ref = {
  projectId: "project-1",
  harnessAgentId: "claude-code",
  sessionId: "session-1",
} as const;

// Chunk folds run on microtasks (ReadableStream consumers): settle before
// asserting on folded messages.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

class FakeTransport implements ChatSessionTransport {
  onEvent: ((event: ChatTransportEvent) => void) | null = null;
  disposed = 0;
  history: readonly UIMessage[] | null = null;
  // When set, getMessages blocks on it — for tests that race the history
  // floor against live traffic.
  historyGate: Promise<void> | null = null;
  getMessagesCalls = 0;
  promptCalls: Array<{ messageId: string; parts: ReadonlyArray<PromptPart> }> = [];
  steerCalls: Array<{
    expectedTurnId: string;
    messageId: string;
    parts: ReadonlyArray<PromptPart>;
  }> = [];
  promptError: unknown = null;
  steerError: unknown = null;
  steerGates: Promise<void>[] = [];
  promptGates: Promise<void>[] = [];
  // When set, prompt blocks on it — models a call waiting for the WebSocket
  // reconnect loop to reach the restarted server.
  promptGate: Promise<void> | null = null;
  responded: Array<{ requestId: string; response: AgentResponse }> = [];

  subscribe(onEvent: (event: ChatTransportEvent) => void): () => void {
    this.onEvent = onEvent;
    return () => {
      this.disposed += 1;
    };
  }
  prompt = async (input: { messageId: string; parts: ReadonlyArray<PromptPart> }) => {
    this.promptCalls.push(input);
    const gate = this.promptGates.shift() ?? this.promptGate;
    const error = this.promptError;
    if (gate) await gate;
    if (error) throw error;
    return { turnId: "turn-receipt" };
  };
  steer = async (input: {
    expectedTurnId: string;
    messageId: string;
    parts: ReadonlyArray<PromptPart>;
  }) => {
    this.steerCalls.push(input);
    const gate = this.steerGates.shift();
    if (gate) await gate;
    if (this.steerError) throw this.steerError;
  };

  getMessages = async () => {
    this.getMessagesCalls += 1;
    const history = this.history;
    const gate = this.historyGate;
    if (gate) await gate;
    return history;
  };
  respondToAgentRequest = async (requestId: string, response: AgentResponse) => {
    this.responded.push({ requestId, response });
  };
  setModel = async (_providerId: string, _modelId: string) => {};
  setReasoningEffort = async (_effort: ReasoningEffort) => {};
  setPermissionMode = async (_mode: PermissionMode) => {};
}

const makeChat = (options?: { onTerminated?: () => void }) => {
  const transport = new FakeTransport();
  const chat = new Chat({ sessionRef: ref, transport, onTerminated: options?.onTerminated });
  const emit = (event: ChatTransportEvent) => transport.onEvent?.(event);
  const attach = async (snapshot: Partial<SessionRuntimeSnapshot>) => {
    emit({
      type: "attached",
      snapshot: {
        ref,
        status: { phase: "idle" },
        activeTurn: null,
        activePrompt: null,
        acceptedPrompt: null,
        acceptedPrompts: [],
        pendingPrompts: [],
        pendingRequests: [],
        cursor: 0,
        ...snapshot,
      },
    });
    await settle();
  };
  const live = (seq: number, body: SessionScopedEventBody & { phase?: SessionPhase }) =>
    emit({ seq, ref, ...body } as SessionScopedEvent);
  return { chat, transport, attach, live, emit };
};

const chunkEvent = (seq: number, turnId: string, chunk: UIMessageChunk): SessionMessageChunkEvent =>
  ({ seq, ref, type: "session.message.chunk", turnId, chunk }) as SessionMessageChunkEvent;

type ActiveTurnInit = Partial<NonNullable<SessionRuntimeSnapshot["activeTurn"]>> & {
  turnId: string;
  chunks: SessionMessageChunkEvent[];
};

const activeTurn = (init: ActiveTurnInit): NonNullable<SessionRuntimeSnapshot["activeTurn"]> => ({
  messageId: null,
  complete: false,
  truncated: false,
  ...init,
});

const textChunks = (id: string, text: string): UIMessageChunk[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistantText = (message: UIMessage): string =>
  message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

const toolRequest: AgentRequest = {
  type: "tool",
  id: "request-1",
  harnessAgentId: "claude-code",
  toolName: "Bash",
  input: { command: "pwd" },
  actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
  native: null,
};

describe("Chat hydration", () => {
  // Reattaching across a server restart: the session's seq counter is rebuilt
  // from scratch, so the next turn's events all land below the cursor we were
  // holding. Keeping that cursor drops the entire turn and the page sits on a
  // spinner forever — the exact failure a live restart produced.
  it("rejoins from scratch when the server's seq counter has restarted", async () => {
    const { chat, transport, attach, live } = makeChat();
    transport.history = [userMessage("user-1", "hello")];
    await attach({ cursor: 8 });
    expect(chat.store.getState().session.messages).toHaveLength(1);

    transport.history = [userMessage("user-1", "hello")];
    await attach({ cursor: 0 });

    const [start, delta, end] = textChunks("t", "after the restart");
    for (const [seq, chunk] of [start!, delta!, end!].entries()) {
      live(seq + 1, { type: "session.message.chunk", turnId: "turn-1", chunk });
    }
    await settle();

    const last = chat.store.getState().session.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(assistantText(last)).toBe("after the restart");
  });

  it("keeps a pending prompt across a restarted server snapshot", async () => {
    const { chat, transport, attach } = makeChat();
    transport.history = [userMessage("user-1", "hello")];
    await attach({ cursor: 8 });

    let releasePrompt: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const sent = chat.prompt("still queued");
    await settle();

    // The rebuilt server starts at cursor zero and has not accepted the prompt
    // yet, so neither its idle phase nor its settled history may erase the
    // optimistic bubble.
    await attach({ cursor: 0 });
    expect(chat.store.getState().session.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
    expect(chat.store.getState().session.status).toBe("submitted");

    releasePrompt();
    await sent;
    // The cursor-zero snapshot predated acceptance, so settling the RPC must
    // not briefly turn its stale idle phase into a ready composer.
    expect(chat.store.getState().session.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
    expect(chat.store.getState().session.status).toBe("submitted");
  });

  it("applies a completed restart snapshot when the pending prompt settles", async () => {
    const { chat, transport, attach } = makeChat();
    const oldHistory = [userMessage("user-1", "hello")];
    transport.history = oldHistory;
    await attach({ cursor: 8 });

    let releasePrompt: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const sent = chat.prompt("still queued");
    await settle();
    const { messageId } = transport.promptCalls[0]!;

    // The restarted server has already accepted and completed the turn, but
    // the unary prompt receipt is still pending on the recovering connection.
    transport.history = [
      ...oldHistory,
      userMessage(messageId, "still queued"),
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "completed while reconnecting" }],
      },
    ];
    await attach({
      activePrompt: {
        messageId,
        parts: [{ type: "text", text: "still queued" }],
        seq: 1,
        acceptedTurnId: "turn-complete",
      },
      activeTurn: activeTurn({ turnId: "turn-complete", chunks: [], complete: true }),
      cursor: 6,
    });
    expect(chat.store.getState().session.status).toBe("submitted");

    releasePrompt();
    await sent;
    await settle();

    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "user-1",
      messageId,
      "assistant-1",
    ]);
    expect(chat.store.getState().session.status).toBe("ready");
  });

  it("ignores a stale history read that overlapped a prompt", async () => {
    const { chat, transport, attach, live } = makeChat();
    const oldHistory = [userMessage("user-1", "hello")];
    transport.history = oldHistory;
    await attach({ cursor: 8 });

    let releaseStaleHistory: () => void = () => undefined;
    transport.historyGate = new Promise((resolve) => {
      releaseStaleHistory = resolve;
    });
    // Start a slow reconciliation before our prompt exists. Its response has
    // already captured the old settled transcript.
    live(9, { type: "session.turn.ended", turnId: "other", outcome: "canceled", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(2);

    await chat.prompt("new prompt");
    const { messageId } = transport.promptCalls[0]!;

    // A later attach obtains authoritative history and clears submitted. The
    // older response must not overwrite this newer state when it finally lands.
    transport.historyGate = null;
    transport.history = [
      ...oldHistory,
      userMessage(messageId, "new prompt"),
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
    ];
    await attach({ cursor: 20 });
    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "user-1",
      messageId,
      "assistant-1",
    ]);

    releaseStaleHistory();
    await settle();

    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "user-1",
      messageId,
      "assistant-1",
    ]);
  });

  it("lays the history floor before folding buffered or live chunks", async () => {
    const { chat, transport, attach, live } = makeChat();
    transport.history = [userMessage("user-1", "hello")];
    const [start, delta] = textChunks("t", "buffered");
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(1, "turn-1", start!), chunkEvent(2, "turn-1", delta!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    live(3, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "text-end", id: "t" },
    });
    await settle();
    const messages = chat.store.getState().session.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(assistantText(messages[1]!)).toBe("buffered");
    expect(chat.store.getState().session.status).toBe("streaming");
  });

  it("gates live events by seq so buffered replay never double-folds", async () => {
    const { chat, attach, live } = makeChat();
    const [start, delta] = textChunks("t", "once");
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(1, "turn-1", start!), chunkEvent(2, "turn-1", delta!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    // The same delta redelivered at its already-folded seq must be dropped.
    live(2, { type: "session.message.chunk", turnId: "turn-1", chunk: delta! });
    live(3, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "text-end", id: "t" },
    });
    await settle();
    const assistant = chat.store.getState().session.messages.at(-1)!;
    expect(assistantText(assistant)).toBe("once");
  });

  it("skips a complete buffer at first attach — the floor already covers it", async () => {
    const { chat, transport, attach } = makeChat();
    transport.history = [userMessage("user-1", "hello"), userMessage("assistant-1", "done")];
    const [start, delta, end] = textChunks("t", "stale");
    await attach({
      activeTurn: activeTurn({
        turnId: "turn-old",
        chunks: [
          chunkEvent(1, "turn-old", start!),
          chunkEvent(2, "turn-old", delta!),
          chunkEvent(3, "turn-old", end!),
        ],
        complete: true,
        truncated: false,
      }),
      cursor: 4,
    });
    expect(chat.store.getState().session.messages).toHaveLength(2);
    expect(chat.store.getState().session.status).toBe("ready");
  });

  it("hydrates from the freshest snapshot when a re-attach races the history floor", async () => {
    const { chat, transport, attach } = makeChat();
    let openGate: () => void = () => undefined;
    transport.historyGate = new Promise((resolve) => {
      openGate = resolve;
    });
    transport.history = [userMessage("user-1", "old prompt"), userMessage("assistant-1", "reply")];
    // Attach #1 starts the (slow) floor read with an idle, empty snapshot.
    await attach({});
    // Server-side drop; re-attach with fresher state: a pending request and a
    // running turn. The floor is still in flight.
    await attach({
      status: { phase: "requires_action" },
      activePrompt: {
        messageId: "m2",
        parts: [{ type: "text", text: "hi" }],
        seq: 11,
        acceptedTurnId: "turn-2",
      },
      activeTurn: activeTurn({ turnId: "turn-2", chunks: [] }),
      pendingRequests: [toolRequest],
      cursor: 12,
    });
    expect(transport.getMessagesCalls).toBe(1);
    openGate();
    await settle();
    // Hydration ran once, from the fresher snapshot: its server state
    // survives, with the settled floor laid underneath.
    const state = chat.store.getState();
    expect(state.session.pendingRequests.map((request) => request.id)).toEqual(["request-1"]);
    expect(state.session.status).toBe("streaming");
    expect(state.session.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "m2",
    ]);
  });

  it("re-reads history when a whole turn completed inside a subscription drop", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    expect(transport.getMessagesCalls).toBe(1);
    // While detached, turn-1 (seqs 1..9) ran to completion and turn-2 already
    // started: the snapshot retains only turn-2's prompt and buffer.
    transport.history = [userMessage("user-1", "first"), userMessage("assistant-1", "reply")];
    const [start] = textChunks("t2", "");
    await attach({
      status: { phase: "running" },
      activePrompt: {
        messageId: "m2",
        parts: [{ type: "text", text: "second" }],
        seq: 10,
        acceptedTurnId: "turn-2",
      },
      activeTurn: activeTurn({ turnId: "turn-2", chunks: [chunkEvent(12, "turn-2", start!)] }),
      cursor: 12,
    });
    await settle();
    // The gap (seqs 1..9) starts before anything the snapshot retains — only
    // the settled transcript still has turn-1, so it is re-read…
    expect(transport.getMessagesCalls).toBe(2);
    // …but not applied over the streaming turn: the deferred reconcile lands
    // at the turn boundary.
    live(13, { type: "session.turn.ended", turnId: "turn-2", outcome: "completed", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(3);
    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("replays the retained prompt so the user bubble lands above the streaming reply", async () => {
    const { chat, attach } = makeChat();
    const [start] = textChunks("t", "");
    await attach({
      status: { phase: "running" },
      activePrompt: {
        messageId: "prompt-1",
        parts: [{ type: "text", text: "run it" }],
        seq: 1,
        acceptedTurnId: "turn-1",
      },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(2, "turn-1", start!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    const messages = chat.store.getState().session.messages;
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.id).toBe("prompt-1");
  });
});

// An empty transcript means two different things before and after the floor
// lands, and the transcript renders a verdict on it — so the state is asserted
// rather than inferred from `messages.length`.
describe("Chat history floor state", () => {
  it("stays 'loading' until the floor lands, then settles even on an empty read", async () => {
    const { chat, transport, attach } = makeChat();
    let openGate: () => void = () => undefined;
    transport.historyGate = new Promise((resolve) => {
      openGate = resolve;
    });
    transport.history = [];
    expect(chat.store.getState().session.historyStatus).toBe("loading");
    await attach({});
    expect(chat.store.getState().session.historyStatus).toBe("loading");
    openGate();
    await settle();
    expect(chat.store.getState().session.historyStatus).toBe("settled");
  });

  // Both ways a read comes back with no floor — capability absent, read threw —
  // land on the same state: the transcript says so instead of showing a blank
  // that would read as "nothing was ever said".
  it("marks the history unavailable when the harness has no read", async () => {
    const { chat, transport, attach } = makeChat();
    transport.history = null;
    await attach({});
    expect(chat.store.getState().session.historyStatus).toBe("unavailable");
  });

  it("marks the history unavailable when the read fails", async () => {
    const { chat, transport, attach } = makeChat();
    transport.getMessages = async () => {
      throw new Error("rpc failed");
    };
    await attach({});
    expect(chat.store.getState().session.historyStatus).toBe("unavailable");
  });

  it("stops loading when the session terminates before any floor landed", async () => {
    const { chat, emit } = makeChat();
    emit({ type: "closed", reason: "session_deleted" });
    expect(chat.store.getState().session.historyStatus).toBe("settled");
  });
});

describe("Chat steering", () => {
  it("steers an existing queued follow-up without creating another message", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    const prompt = chat.prompt("change direction");
    void prompt.catch(() => undefined);
    const queued = chat.store.getState().outgoing[0]!;

    expect(chat.steer(queued.message.id)).toBeUndefined();
    await expect(prompt).resolves.toBeUndefined();
    expect(transport.steerCalls).toEqual([
      {
        expectedTurnId: "turn-1",
        messageId: queued.message.id,
        parts: [{ type: "text", text: "change direction" }],
      },
    ]);
    expect(transport.promptCalls).toEqual([]);
    expect(chat.store.getState().outgoing).toEqual([]);
  });

  it("settles an accepted steer before unary completion and ignores its late rejection", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    let release!: () => void;
    transport.steerGates.push(new Promise<void>((resolve) => (release = resolve)));
    const prompt = chat.prompt("change direction");
    const messageId = chat.store.getState().outgoing[0]!.message.id;
    chat.steer(messageId);

    live(1, {
      type: "session.prompt.accepted",
      messageId,
      turnId: "turn-1",
      phase: "running",
    });
    await expect(prompt).resolves.toBeUndefined();
    expect(chat.store.getState().outgoing).toEqual([]);

    transport.steerError = new Error("late unary failure");
    release();
    await settle();
    expect(chat.store.getState().outgoing).toEqual([]);
  });

  it("keeps an authoritatively rejected steer explicit and ignores late unary completion", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    let release!: () => void;
    transport.steerGates.push(new Promise<void>((resolve) => (release = resolve)));
    const prompt = chat.prompt("change direction");
    const messageId = chat.store.getState().outgoing[0]!.message.id;
    chat.steer(messageId);

    live(1, {
      type: "session.prompt.rejected",
      messageId,
      reason: "turn changed",
      phase: "running",
    });
    await expect(prompt).rejects.toThrow("turn changed");
    expect(chat.store.getState().outgoing[0]).toMatchObject({
      message: { id: messageId },
      delivery: "steer",
      status: "failed",
    });

    release();
    await settle();
    expect(chat.store.getState().outgoing[0]).toMatchObject({
      message: { id: messageId },
      delivery: "steer",
      status: "failed",
    });
  });

  it("settles a steer from an authoritative reconnect snapshot", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    let release!: () => void;
    transport.steerGates.push(new Promise<void>((resolve) => (release = resolve)));
    const prompt = chat.prompt("change direction");
    const outgoing = chat.store.getState().outgoing[0]!;
    chat.steer(outgoing.message.id);

    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
      acceptedPrompt: {
        messageId: outgoing.message.id,
        parts: outgoing.parts,
        seq: 1,
        acceptedTurnId: "turn-1",
      },
      cursor: 1,
    });
    await expect(prompt).resolves.toBeUndefined();
    expect(chat.store.getState().outgoing).toEqual([]);
    release();
  });

  it("settles every accepted steer from a reconnect snapshot in server order", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    transport.steerGates.push(
      new Promise<void>((resolve) => (releaseFirst = resolve)),
      new Promise<void>((resolve) => (releaseSecond = resolve)),
    );

    const first = chat.prompt("first steer");
    const firstOutgoing = chat.store.getState().outgoing[0]!;
    chat.steer(firstOutgoing.message.id);
    const second = chat.prompt("second steer");
    const secondOutgoing = chat.store.getState().outgoing.at(-1)!;
    chat.steer(secondOutgoing.message.id);
    expect(transport.steerCalls.map((call) => call.messageId)).toEqual([firstOutgoing.message.id]);

    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
      activePrompt: {
        messageId: secondOutgoing.message.id,
        parts: secondOutgoing.parts,
        seq: 4,
        acceptedTurnId: "turn-1",
      },
      acceptedPrompt: {
        messageId: secondOutgoing.message.id,
        parts: secondOutgoing.parts,
        seq: 4,
        acceptedTurnId: "turn-1",
      },
      acceptedPrompts: [
        {
          messageId: firstOutgoing.message.id,
          parts: firstOutgoing.parts,
          seq: 2,
          acceptedTurnId: "turn-1",
        },
        {
          messageId: secondOutgoing.message.id,
          parts: secondOutgoing.parts,
          seq: 4,
          acceptedTurnId: "turn-1",
        },
        // A duplicated compatibility projection must not settle twice.
        {
          messageId: secondOutgoing.message.id,
          parts: secondOutgoing.parts,
          seq: 4,
          acceptedTurnId: "turn-1",
        },
      ],
      cursor: 4,
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(chat.store.getState().outgoing).toEqual([]);
    expect(transport.steerCalls.map((call) => call.messageId)).toEqual([firstOutgoing.message.id]);

    releaseFirst();
    releaseSecond();
    await settle();
    expect(chat.store.getState().outgoing).toEqual([]);
  });

  it("keeps a failed steer explicit and rejects the original prompt promise", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    const prompt = chat.prompt("change direction");
    const messageId = chat.store.getState().outgoing[0]!.message.id;
    transport.steerError = new Error("turn changed");

    expect(chat.steer(messageId)).toBeUndefined();
    await expect(prompt).rejects.toThrow("turn changed");
    expect(chat.store.getState().outgoing[0]).toMatchObject({
      delivery: "steer",
      status: "failed",
      error: new Error("turn changed"),
    });
    expect(transport.promptCalls).toEqual([]);
  });

  it("dispatches multiple steers FIFO and leaves follow-ups waiting", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    let releaseFirst!: () => void;
    transport.steerGates.push(
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );

    const first = chat.prompt("first steer");
    const firstId = chat.store.getState().outgoing[0]!.message.id;
    chat.steer(firstId);
    const second = chat.prompt("second steer");
    const secondId = chat.store.getState().outgoing.at(-1)!.message.id;
    chat.steer(secondId);
    const followUp = chat.prompt("after turn");
    void followUp.catch(() => undefined);

    expect(transport.steerCalls.map((call) => call.messageId)).toEqual([firstId]);
    expect(transport.promptCalls).toEqual([]);
    expect(chat.store.getState().outgoing).toMatchObject([
      { delivery: "steer", status: "sending" },
      { delivery: "steer", status: "queued" },
      { delivery: "follow-up", status: "queued" },
    ]);

    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(transport.steerCalls.map((call) => call.messageId)).toEqual([firstId, secondId]);
    expect(transport.promptCalls).toEqual([]);
    chat.dispose();
    await expect(followUp).rejects.toThrow("Chat disposed");
  });

  it("settles a failed steer once and does not leak it through dispose", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    transport.steerError = new Error("turn changed");
    const prompt = chat.prompt("change direction");
    void prompt.catch(() => undefined);
    const messageId = chat.store.getState().outgoing[0]!.message.id;

    chat.steer(messageId);
    await expect(prompt).rejects.toThrow("turn changed");
    chat.dispose();
    expect(chat.store.getState().outgoing).toEqual([]);
  });

  it("rejects a failed steer once and clears it on session termination", async () => {
    const { chat, transport, attach, emit } = makeChat();
    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    transport.steerError = new Error("turn changed");
    const prompt = chat.prompt("change direction");
    void prompt.catch(() => undefined);
    const messageId = chat.store.getState().outgoing[0]!.message.id;

    chat.steer(messageId);
    await expect(prompt).rejects.toThrow("turn changed");
    emit({ type: "closed", reason: "session_deleted" });
    expect(chat.store.getState().outgoing).toEqual([]);
  });
});

describe("Chat prompting", () => {
  it("hydrates every unresolved prompt when multiple candidates are pending", async () => {
    const { chat, attach, live } = makeChat();
    const pendingA = {
      messageId: "pending-a",
      parts: [{ type: "text" as const, text: "A" }],
      seq: 3,
      acceptedTurnId: null,
    };
    const pendingB = {
      messageId: "pending-b",
      parts: [{ type: "text" as const, text: "B" }],
      seq: 4,
      acceptedTurnId: null,
    };
    await attach({
      status: { phase: "idle" },
      activePrompt: pendingB,
      pendingPrompts: [pendingA, pendingB],
      activeTurn: activeTurn({ turnId: "turn-old", chunks: [], complete: true }),
      cursor: 4,
    });

    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "pending-a",
      "pending-b",
    ]);

    live(5, {
      type: "session.prompt.accepted",
      messageId: "pending-a",
      turnId: "turn-a",
      phase: "idle",
    });
    live(6, {
      type: "session.prompt.rejected",
      messageId: "pending-b",
      reason: "turn running",
      phase: "idle",
    });
    live(7, { type: "session.turn.started", turnId: "turn-a", phase: "running" });

    expect(chat.store.getState().session.messages.map((message) => message.id)).toEqual([
      "pending-a",
    ]);
  });

  it("waits for the initial session snapshot before dispatching", async () => {
    const { chat, transport, attach } = makeChat();
    const submitted = chat.prompt("early");
    await settle();

    expect(transport.promptCalls).toEqual([]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toHaveLength(1);

    await attach({});
    await submitted;
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("queues a second prompt until the active turn ends", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});

    await chat.prompt("first");
    const first = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.submitted",
      messageId: first.messageId,
      parts: first.parts,
      phase: "idle",
    });
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(3, {
      type: "session.prompt.accepted",
      messageId: first.messageId,
      turnId: "turn-1",
      phase: "running",
    });

    const second = chat.prompt("second");
    await settle();

    expect(transport.promptCalls).toHaveLength(1);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.parts),
    ).toEqual([[{ type: "text", text: "second" }]]);

    live(4, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    await second;

    expect(transport.promptCalls).toHaveLength(2);
    expect(transport.promptCalls[1]?.parts).toEqual([{ type: "text", text: "second" }]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toEqual([]);
  });

  it("does not advance when acceptance is stamped idle before turn.started", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("first");
    const second = chat.prompt("second");
    const firstCall = transport.promptCalls[0]!;

    live(1, {
      type: "session.prompt.submitted",
      messageId: firstCall.messageId,
      parts: firstCall.parts,
      phase: "idle",
    });
    live(2, {
      type: "session.prompt.accepted",
      messageId: firstCall.messageId,
      turnId: "turn-1",
      phase: "idle",
    });
    await settle();
    expect(transport.promptCalls).toHaveLength(1);

    live(3, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(4, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    await second;
    expect(transport.promptCalls).toHaveLength(2);
  });

  it("advances when turn.ended is drained before its prompt.accepted correlation", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("first");
    const second = chat.prompt("second");
    const firstCall = transport.promptCalls[0]!;

    live(1, {
      type: "session.prompt.submitted",
      messageId: firstCall.messageId,
      parts: firstCall.parts,
      phase: "idle",
    });
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(3, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    expect(transport.promptCalls).toHaveLength(1);

    live(4, {
      type: "session.prompt.accepted",
      messageId: firstCall.messageId,
      turnId: "turn-1",
      phase: "idle",
    });
    await second;
    expect(transport.promptCalls).toHaveLength(2);
  });

  it("keeps local correlation after the unary receipt until stream acceptance arrives", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});

    await chat.prompt("first");
    const second = chat.prompt("second");
    live(1, {
      type: "session.prompt.rejected",
      messageId: "older-remote-prompt",
      reason: "stale rejection",
      phase: "idle",
    });
    await settle();
    expect(transport.promptCalls).toHaveLength(1);

    const firstCall = transport.promptCalls[0]!;
    live(2, {
      type: "session.prompt.submitted",
      messageId: firstCall.messageId,
      parts: firstCall.parts,
      phase: "idle",
    });
    live(3, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(4, {
      type: "session.prompt.accepted",
      messageId: firstCall.messageId,
      turnId: "turn-1",
      phase: "running",
    });
    live(5, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    await second;
    expect(transport.promptCalls).toHaveLength(2);
  });

  it("waits for the turn boundary rather than only the prompt receipt", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});

    let releaseFirst: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = chat.prompt("first");
    const second = chat.prompt("second");
    await settle();
    expect(transport.promptCalls).toHaveLength(1);

    releaseFirst();
    await first;
    await settle();
    expect(transport.promptCalls).toHaveLength(1);

    const firstCall = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.submitted",
      messageId: firstCall.messageId,
      parts: firstCall.parts,
      phase: "idle",
    });
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(3, {
      type: "session.prompt.accepted",
      messageId: firstCall.messageId,
      turnId: "turn-1",
      phase: "running",
    });
    live(4, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    await second;

    expect(transport.promptCalls).toHaveLength(2);
  });

  it("does not dispatch while a retained prompt is still awaiting harness acceptance", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-old", chunks: [] }),
      cursor: 3,
    });
    const queued = chat.prompt("local next");

    await attach({
      status: { phase: "idle" },
      activePrompt: {
        messageId: "remote-prompt",
        parts: [{ type: "text", text: "remote next" }],
        seq: 4,
        acceptedTurnId: null,
      },
      pendingPrompts: [
        {
          messageId: "remote-prompt",
          parts: [{ type: "text", text: "remote next" }],
          seq: 4,
          acceptedTurnId: null,
        },
      ],
      activeTurn: null,
      cursor: 4,
    });
    expect(transport.promptCalls).toEqual([]);

    live(5, { type: "session.turn.started", turnId: "turn-remote", phase: "running" });
    live(6, {
      type: "session.prompt.accepted",
      messageId: "remote-prompt",
      turnId: "turn-remote",
      phase: "running",
    });
    live(7, {
      type: "session.turn.ended",
      turnId: "turn-remote",
      outcome: "completed",
      phase: "idle",
    });
    await queued;
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("does not treat an idle accepted snapshot as completed until its turn matches", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-old", chunks: [] }),
      cursor: 3,
    });
    const queued = chat.prompt("local next");

    await attach({
      status: { phase: "idle" },
      activePrompt: {
        messageId: "remote-prompt",
        parts: [{ type: "text", text: "remote next" }],
        seq: 4,
        acceptedTurnId: "turn-remote",
      },
      activeTurn: activeTurn({ turnId: "turn-old", chunks: [], complete: true }),
      cursor: 5,
    });
    expect(transport.promptCalls).toEqual([]);

    live(6, { type: "session.turn.started", turnId: "turn-remote", phase: "running" });
    live(7, {
      type: "session.turn.ended",
      turnId: "turn-remote",
      outcome: "completed",
      phase: "idle",
    });
    await queued;
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("keeps older unresolved submissions after the newer candidate is rejected", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    live(1, {
      type: "session.prompt.submitted",
      messageId: "remote-a",
      parts: [{ type: "text", text: "A" }],
      phase: "idle",
    });
    live(2, {
      type: "session.prompt.submitted",
      messageId: "remote-b",
      parts: [{ type: "text", text: "B" }],
      phase: "idle",
    });
    const queued = chat.prompt("local next");

    live(3, {
      type: "session.prompt.rejected",
      messageId: "remote-b",
      reason: "turn running",
      phase: "idle",
    });
    expect(transport.promptCalls).toEqual([]);

    live(4, {
      type: "session.prompt.accepted",
      messageId: "remote-a",
      turnId: "turn-a",
      phase: "idle",
    });
    live(5, { type: "session.turn.started", turnId: "turn-a", phase: "running" });
    live(6, {
      type: "session.turn.ended",
      turnId: "turn-a",
      outcome: "completed",
      phase: "idle",
    });
    await queued;
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("ignores a stale acceptance after a newer turn already ended", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.turn.started", turnId: "turn-new", phase: "running" });
    live(2, {
      type: "session.turn.ended",
      turnId: "turn-new",
      outcome: "completed",
      phase: "idle",
    });
    live(3, {
      type: "session.prompt.accepted",
      messageId: "older-prompt",
      turnId: "turn-old",
      phase: "idle",
    });

    await chat.prompt("still dispatches");
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("keeps the boundary closed when an older prompt is rejected after a newer submission", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-old", chunks: [] }),
      cursor: 3,
    });
    const queued = chat.prompt("local next");

    live(4, {
      type: "session.prompt.submitted",
      messageId: "remote-new",
      parts: [{ type: "text", text: "remote next" }],
      phase: "running",
    });
    live(5, {
      type: "session.turn.ended",
      turnId: "turn-old",
      outcome: "completed",
      phase: "idle",
    });
    live(6, {
      type: "session.prompt.rejected",
      messageId: "remote-old",
      reason: "stale rejection",
      phase: "idle",
    });
    expect(transport.promptCalls).toEqual([]);

    live(7, { type: "session.turn.started", turnId: "turn-remote", phase: "running" });
    live(8, {
      type: "session.prompt.accepted",
      messageId: "remote-new",
      turnId: "turn-remote",
      phase: "running",
    });
    live(9, {
      type: "session.turn.ended",
      turnId: "turn-remote",
      outcome: "completed",
      phase: "idle",
    });
    await queued;
    expect(transport.promptCalls).toHaveLength(1);
  });

  it("reconciles a local accepted prompt masked by a newer remote candidate", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    let releaseFirst: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = chat.prompt("local first");
    const second = chat.prompt("local second");
    await settle();
    const localMessageId = transport.promptCalls[0]!.messageId;

    await attach({
      status: { phase: "running" },
      activePrompt: {
        messageId: "remote-pending",
        parts: [{ type: "text", text: "remote" }],
        seq: 2,
        acceptedTurnId: null,
      },
      acceptedPrompt: {
        messageId: localMessageId,
        parts: [{ type: "text", text: "local first" }],
        seq: 1,
        acceptedTurnId: "turn-local",
      },
      pendingPrompts: [
        {
          messageId: "remote-pending",
          parts: [{ type: "text", text: "remote" }],
          seq: 2,
          acceptedTurnId: null,
        },
      ],
      activeTurn: activeTurn({ turnId: "turn-local", chunks: [] }),
      cursor: 3,
    });
    releaseFirst();
    await first;

    live(4, {
      type: "session.prompt.rejected",
      messageId: "remote-pending",
      reason: "turn running",
      phase: "running",
    });
    expect(transport.promptCalls).toHaveLength(1);
    live(5, {
      type: "session.turn.ended",
      turnId: "turn-local",
      outcome: "completed",
      phase: "idle",
    });
    await second;
    expect(transport.promptCalls).toHaveLength(2);
  });

  it("keeps queued prompts across reattach and dispatches them from an idle snapshot", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
      cursor: 4,
    });

    const queued = chat.prompt("after restart");
    await settle();
    expect(transport.promptCalls).toEqual([]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toHaveLength(1);

    // The queue belongs to the Chat, so a server-side runtime rebuild does not
    // erase it. The fresh idle snapshot is the next safe dispatch boundary.
    await attach({ status: { phase: "idle" }, activeTurn: null, cursor: 0 });
    await queued;

    expect(transport.promptCalls).toHaveLength(1);
    expect(transport.promptCalls[0]?.parts).toEqual([{ type: "text", text: "after restart" }]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toEqual([]);
  });

  it("preserves FIFO order across consecutive turns", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});

    await chat.prompt("first");
    const first = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.submitted",
      messageId: first.messageId,
      parts: first.parts,
      phase: "idle",
    });
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(3, {
      type: "session.prompt.accepted",
      messageId: first.messageId,
      turnId: "turn-1",
      phase: "running",
    });

    const second = chat.prompt("second");
    const third = chat.prompt("third");
    await settle();
    expect(transport.promptCalls.map((call) => call.parts[0])).toEqual([
      { type: "text", text: "first" },
    ]);

    live(4, {
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      phase: "idle",
    });
    await second;
    expect(transport.promptCalls.map((call) => call.parts[0])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.parts[0]),
    ).toEqual([{ type: "text", text: "third" }]);

    const secondCall = transport.promptCalls[1]!;
    live(5, {
      type: "session.prompt.submitted",
      messageId: secondCall.messageId,
      parts: secondCall.parts,
      phase: "idle",
    });
    live(6, { type: "session.turn.started", turnId: "turn-2", phase: "running" });
    live(7, {
      type: "session.prompt.accepted",
      messageId: secondCall.messageId,
      turnId: "turn-2",
      phase: "running",
    });
    live(8, {
      type: "session.turn.ended",
      turnId: "turn-2",
      outcome: "completed",
      phase: "idle",
    });
    await third;

    expect(transport.promptCalls.map((call) => call.parts[0])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toEqual([]);
  });

  it("waits for an authoritative idle snapshot after an ambiguous head failure", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({});
    transport.promptError = new Error("connection lost");
    const first = chat.prompt("first");
    const second = chat.prompt("second");
    await expect(first).rejects.toThrow("connection lost");
    await settle();
    expect(transport.promptCalls).toHaveLength(1);
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toHaveLength(1);

    transport.promptError = null;
    await attach({ status: { phase: "idle" }, activePrompt: null, activeTurn: null, cursor: 0 });
    await second;

    expect(transport.promptCalls).toHaveLength(2);
    expect(transport.promptCalls[1]?.parts).toEqual([{ type: "text", text: "second" }]);
  });

  it("advances the FIFO when the server explicitly rejects the failed head", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    transport.promptError = new Error("turn already running");
    const first = chat.prompt("first");
    const second = chat.prompt("second");
    await expect(first).rejects.toThrow("turn already running");
    expect(transport.promptCalls).toHaveLength(1);

    transport.promptError = null;
    const firstCall = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.rejected",
      messageId: firstCall.messageId,
      reason: "turn running",
      phase: "idle",
    });
    await second;

    expect(transport.promptCalls).toHaveLength(2);
    expect(transport.promptCalls[1]?.parts).toEqual([{ type: "text", text: "second" }]);
  });

  it("advances when rejection evidence arrives before the unary RPC rejects", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    let releaseFirst: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    transport.promptError = new Error("turn already running");
    const first = chat.prompt("first");
    const firstRejection = first.catch((error: unknown) => error);
    const second = chat.prompt("second");
    await settle();

    const firstCall = transport.promptCalls[0]!;
    transport.promptError = null;
    live(1, {
      type: "session.prompt.submitted",
      messageId: firstCall.messageId,
      parts: firstCall.parts,
      phase: "idle",
    });
    live(2, {
      type: "session.prompt.rejected",
      messageId: firstCall.messageId,
      reason: "turn running",
      phase: "idle",
    });
    expect(await firstRejection).toMatchObject({ message: "turn running" });
    releaseFirst();
    await settle();
    await second;
    expect(transport.promptCalls).toHaveLength(2);
    expect(transport.promptCalls[1]?.parts).toEqual([{ type: "text", text: "second" }]);
  });

  it("settles an accepted follow-up before unary completion and ignores its late rejection", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    let release!: () => void;
    transport.promptGates.push(new Promise<void>((resolve) => (release = resolve)));
    const prompt = chat.prompt("first");
    const messageId = transport.promptCalls[0]!.messageId;

    live(1, {
      type: "session.prompt.accepted",
      messageId,
      turnId: "turn-1",
      phase: "running",
    });
    await expect(prompt).resolves.toBeUndefined();
    expect(chat.store.getState().outgoing).toEqual([]);

    transport.promptError = new Error("late unary failure");
    release();
    await settle();
    expect(chat.store.getState().outgoing).toEqual([]);
  });

  it("settles a rejected follow-up before unary failure and ignores the late failure", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    let release!: () => void;
    transport.promptGates.push(new Promise<void>((resolve) => (release = resolve)));
    transport.promptError = new Error("late unary failure");
    const prompt = chat.prompt("first");
    const messageId = transport.promptCalls[0]!.messageId;

    live(1, {
      type: "session.prompt.rejected",
      messageId,
      reason: "turn running",
      phase: "idle",
    });
    await expect(prompt).rejects.toThrow("turn running");
    expect(chat.store.getState().outgoing).toEqual([]);

    release();
    await settle();
    expect(chat.store.getState().outgoing).toEqual([]);
    expect(chat.store.getState().session.error).toBeUndefined();
  });

  it("settles a follow-up from reconnect accepted correlation while retaining pending peers", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({});
    let release!: () => void;
    transport.promptGates.push(new Promise<void>((resolve) => (release = resolve)));
    const first = chat.prompt("first");
    const second = chat.prompt("second");
    void second.catch(() => undefined);
    const firstCall = transport.promptCalls[0]!;
    const secondOutgoing = chat.store.getState().outgoing[1]!;

    await attach({
      status: { phase: "running", activeTurnId: "turn-1" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
      acceptedPrompt: {
        messageId: firstCall.messageId,
        parts: firstCall.parts,
        seq: 1,
        acceptedTurnId: "turn-1",
      },
      pendingPrompts: [
        {
          messageId: secondOutgoing.message.id,
          parts: secondOutgoing.parts,
          seq: 2,
          acceptedTurnId: null,
        },
      ],
      cursor: 2,
    });
    await expect(first).resolves.toBeUndefined();
    expect(chat.store.getState().outgoing).toMatchObject([
      { message: { id: secondOutgoing.message.id }, delivery: "follow-up", status: "queued" },
    ]);

    release();
    chat.dispose();
    await expect(second).rejects.toThrow("Chat disposed");
  });

  it("pushes the optimistic message, submits on its turn, and dedupes its echo", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("hello there");
    expect(transport.promptCalls).toHaveLength(1);
    const { messageId } = transport.promptCalls[0]!;
    expect(chat.store.getState().session.status).toBe("submitted");
    // The echo carries the pre-turn idle phase — it must not clear the
    // sender's optimistic "submitted".
    live(1, {
      type: "session.prompt.submitted",
      messageId,
      parts: [{ type: "text", text: "hello there" }],
      phase: "idle",
    });
    expect(chat.store.getState().session.messages).toHaveLength(1);
    expect(chat.store.getState().session.status).toBe("submitted");
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    expect(chat.store.getState().session.status).toBe("streaming");
  });

  it("appends another client's prompt from the broadcast", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    live(1, {
      type: "session.prompt.submitted",
      messageId: "other-1",
      parts: [{ type: "text", text: "from B" }],
      phase: "idle",
    });
    const messages = chat.store.getState().session.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe("other-1");
  });

  it("drops the phantom message when the harness rejects a broadcast prompt", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("loser");
    const { messageId } = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.submitted",
      messageId,
      parts: [{ type: "text", text: "loser" }],
      phase: "idle",
    });
    expect(chat.store.getState().session.messages).toHaveLength(1);
    // The harness rejected the prompt (turn already running): the compensating
    // event removes the user bubble everywhere, optimistic copy included.
    live(2, { type: "session.prompt.rejected", messageId, reason: "turn running", phase: "idle" });
    expect(chat.store.getState().session.messages).toEqual([]);
  });

  it("folds this client's own turn through the same subscription path", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("go");
    const { messageId } = transport.promptCalls[0]!;
    live(1, {
      type: "session.prompt.submitted",
      messageId,
      parts: [{ type: "text", text: "go" }],
      phase: "idle",
    });
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    for (const [index, chunk] of textChunks("t", "reply").entries()) {
      live(3 + index, { type: "session.message.chunk", turnId: "turn-1", chunk });
    }
    live(6, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    const messages = chat.store.getState().session.messages;
    expect(messages).toHaveLength(2);
    expect(assistantText(messages[1]!)).toBe("reply");
    expect(chat.store.getState().session.status).toBe("ready");
  });
});

describe("Chat stream errors", () => {
  it("surfaces the exact live provider error after the turn settles", async () => {
    const { chat, transport, attach, live } = makeChat();
    const providerError = "429: 已达到 5 小时的使用上限。";
    await attach({});

    live(1, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(2, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "error", errorText: providerError },
    });
    // Pi currently follows the error chunk with finish, which the adapter
    // reports as a completed turn. Visibility must not depend on the outcome.
    live(3, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();

    expect(chat.store.getState().session.error?.message).toBe(providerError);
    expect(chat.store.getState().session.status).toBe("ready");

    await chat.prompt("retry");
    expect(chat.store.getState().session.error).toBeUndefined();
    expect(chat.store.getState().session.status).toBe("submitted");
    expect(transport.promptCalls.at(-1)?.parts).toEqual([{ type: "text", text: "retry" }]);
  });

  it("restores an unseen provider error after its retained prompt boundary", async () => {
    const { chat, attach } = makeChat();
    const providerError = "Connection error.";
    await attach({ cursor: 1 });

    await attach({
      status: { phase: "idle" },
      activePrompt: {
        messageId: "prompt-1",
        parts: [{ type: "text", text: "go" }],
        seq: 2,
        acceptedTurnId: "turn-1",
      },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [
          chunkEvent(3, "turn-1", {
            type: "error",
            errorText: providerError,
          }),
        ],
        complete: true,
      }),
      cursor: 4,
    });

    expect(chat.store.getState().session.error?.message).toBe(providerError);
  });

  it("lets a newer retained prompt clear an older completed-turn error", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({});
    transport.promptError = new Error("older local failure");
    await expect(chat.prompt("fail first")).rejects.toThrow("older local failure");

    await attach({
      status: { phase: "idle" },
      activePrompt: {
        messageId: "prompt-new",
        parts: [{ type: "text", text: "try again" }],
        seq: 4,
        acceptedTurnId: null,
      },
      pendingPrompts: [
        {
          messageId: "prompt-new",
          parts: [{ type: "text", text: "try again" }],
          seq: 4,
          acceptedTurnId: null,
        },
      ],
      activeTurn: activeTurn({
        turnId: "turn-old",
        chunks: [chunkEvent(2, "turn-old", { type: "error", errorText: "old provider error" })],
        complete: true,
      }),
      cursor: 4,
    });

    expect(chat.store.getState().session.error).toBeUndefined();
    expect(chat.store.getState().session.messages.at(-1)?.id).toBe("prompt-new");
  });

  it("clears a stale error for unseen broadcast and retained prompts", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    transport.promptError = new Error("old failure");
    await expect(chat.prompt("fail first")).rejects.toThrow("old failure");
    live(1, {
      type: "session.prompt.rejected",
      messageId: transport.promptCalls[0]!.messageId,
      reason: "failed",
      phase: "idle",
    });

    live(2, {
      type: "session.prompt.submitted",
      messageId: "remote-1",
      parts: [{ type: "text", text: "remote" }],
      phase: "idle",
    });
    expect(chat.store.getState().session.error).toBeUndefined();

    live(3, {
      type: "session.prompt.rejected",
      messageId: "remote-1",
      reason: "busy",
      phase: "idle",
    });
    transport.promptError = new Error("another old failure");
    await expect(chat.prompt("fail again")).rejects.toThrow("another old failure");
    await attach({
      status: { phase: "running" },
      activePrompt: {
        messageId: "remote-2",
        parts: [{ type: "text", text: "retained" }],
        seq: 4,
        acceptedTurnId: "turn-2",
      },
      activeTurn: activeTurn({ turnId: "turn-2", chunks: [] }),
      cursor: 4,
    });
    expect(chat.store.getState().session.error).toBeUndefined();
  });

  it("does not let a delayed self-echo clear a prompt RPC failure", async () => {
    const { chat, transport, attach, live } = makeChat();
    const promptError = new Error("Prompt RPC failed");
    await attach({});
    transport.promptError = promptError;

    await expect(chat.prompt("go")).rejects.toThrow(promptError);
    const { messageId, parts } = transport.promptCalls[0]!;
    expect(chat.store.getState().session.error?.message).toBe(promptError.message);

    live(1, { type: "session.prompt.submitted", messageId, parts, phase: "idle" });
    expect(chat.store.getState().session.error?.message).toBe(promptError.message);
  });
});

describe("Chat agent requests", () => {
  it("replaces pending requests wholesale on attach and follows live add/remove", async () => {
    const { chat, attach, live } = makeChat();
    await attach({
      status: { phase: "requires_action" },
      pendingRequests: [toolRequest],
      cursor: 1,
    });
    expect(chat.store.getState().session.pendingRequests.map((r) => r.id)).toEqual(["request-1"]);
    const second: AgentRequest = { ...toolRequest, id: "request-2" };
    live(2, { type: "session.request.asked", request: second, phase: "requires_action" });
    expect(chat.store.getState().session.pendingRequests.map((r) => r.id)).toEqual([
      "request-1",
      "request-2",
    ]);
    live(3, { type: "session.request.replied", requestId: "request-1", phase: "requires_action" });
    expect(chat.store.getState().session.pendingRequests.map((r) => r.id)).toEqual(["request-2"]);
    // Re-attach: the snapshot is authoritative — stale local entries vanish.
    await attach({ pendingRequests: [], cursor: 3 });
    expect(chat.store.getState().session.pendingRequests).toEqual([]);
  });

  it("auto-approves an empty plan instead of surfacing a blank card", async () => {
    const { chat, transport, attach } = makeChat();
    const emptyPlan: AgentRequest = {
      type: "plan",
      id: "empty-plan",
      harnessAgentId: "claude-code",
      plan: "",
      native: null,
    };
    await attach({ pendingRequests: [emptyPlan] });
    await settle();
    expect(transport.responded).toEqual([
      { requestId: "empty-plan", response: { type: "plan", behavior: "allow" } },
    ]);
    expect(chat.store.getState().session.pendingRequests).toEqual([]);
  });

  it("drops unanswered requests when the turn ends", async () => {
    const { chat, attach, live } = makeChat();
    await attach({
      status: { phase: "requires_action" },
      pendingRequests: [toolRequest],
      cursor: 1,
    });
    live(2, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    expect(chat.store.getState().session.pendingRequests).toEqual([]);
  });
});

describe("Chat history reconcile", () => {
  it("reconciles from history when a turn ends un-completed", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    expect(transport.getMessagesCalls).toBe(1);
    live(1, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    transport.history = [userMessage("user-1", "prompt"), userMessage("assistant-1", "partial")];
    live(2, { type: "session.turn.ended", turnId: "turn-1", outcome: "failed", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(2);
    expect(chat.store.getState().session.messages.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("reconciles when the stream carried an error chunk but the turn completed", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    live(2, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "error", errorText: "Connection error." },
    });
    transport.history = [userMessage("user-1", "prompt"), userMessage("assistant-1", "retried")];
    live(3, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(2);
    expect(chat.store.getState().session.messages.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("skips the reconcile while a newer turn is already streaming", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    transport.history = [userMessage("user-1", "late")];
    live(2, { type: "session.turn.ended", turnId: "turn-1", outcome: "failed", phase: "idle" });
    // A new turn starts before the reconcile read returns.
    live(3, { type: "session.turn.started", turnId: "turn-2", phase: "running" });
    live(4, {
      type: "session.message.chunk",
      turnId: "turn-2",
      chunk: { type: "text-start", id: "t" },
    });
    await settle();
    // The read happened but its result was not applied over the live turn.
    expect(chat.store.getState().session.messages.map((m) => m.id)).not.toEqual(["user-1"]);
  });
});

describe("Chat truncated buffers", () => {
  it("fresh joiner renders the sanitized tail live and backfills at turn end", async () => {
    const { chat, transport, attach, live } = makeChat();
    // Orphan continuation from the evicted head, then a clean part.
    const orphan: UIMessageChunk = { type: "text-delta", id: "lost", delta: "GARBAGE" };
    const [start, delta] = textChunks("kept", "tail");
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [
          chunkEvent(50, "turn-1", orphan),
          chunkEvent(51, "turn-1", start!),
          chunkEvent(52, "turn-1", delta!),
        ],
        complete: false,
        truncated: true,
      }),
      cursor: 52,
    });
    live(53, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "text-end", id: "kept" },
    });
    await settle();
    const assistant = chat.store.getState().session.messages.at(-1)!;
    expect(assistantText(assistant)).toBe("tail");
    // Turn end: the full turn (including the evicted head) comes back from
    // history.
    transport.history = [userMessage("user-1", "prompt"), userMessage("assistant-1", "full")];
    live(54, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(2);
    expect(chat.store.getState().session.messages.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("returning viewer with a mid-turn hole abandons the live view and recovers at end", async () => {
    const { chat, attach, live, transport } = makeChat();
    const [start, delta] = textChunks("t", "seen");
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(1, "turn-1", start!), chunkEvent(2, "turn-1", delta!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    await settle();
    // Re-attach after a drop: the buffer was truncated meanwhile and its
    // retained head (seq 10) no longer reaches our cursor — the middle is
    // gone. Splicing the tail would fabricate a seamless-looking message.
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(10, "turn-1", { type: "text-delta", id: "t", delta: "LATE" })],
        complete: false,
        truncated: true,
      }),
      cursor: 10,
    });
    live(11, {
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "text-delta", id: "t", delta: "MORE" },
    });
    await settle();
    const assistant = chat.store.getState().session.messages.at(-1)!;
    expect(assistantText(assistant)).toBe("seen");
    transport.history = [userMessage("assistant-1", "whole turn")];
    live(12, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    expect(chat.store.getState().session.messages.map((m) => m.id)).toEqual(["assistant-1"]);
  });

  it("reconciles on re-attach when a flagged turn ended while detached", async () => {
    const { chat, attach, transport, live } = makeChat();
    const [start, delta] = textChunks("t", "seen");
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(1, "turn-1", start!), chunkEvent(2, "turn-1", delta!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    // Drop + truncation while away flags the turn…
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(10, "turn-1", { type: "text-delta", id: "t", delta: "LATE" })],
        complete: false,
        truncated: true,
      }),
      cursor: 10,
    });
    // …and the next drop straddles the turn's end: the ended event (and its
    // reconcile) never arrives, so the re-attach must recover it.
    transport.history = [userMessage("assistant-1", "whole turn")];
    await attach({ status: { phase: "idle" }, activeTurn: null, cursor: 12 });
    await settle();
    expect(chat.store.getState().session.messages.map((m) => m.id)).toEqual(["assistant-1"]);
    void live;
  });
});

describe("Chat lifecycle", () => {
  it("publishes one complete view before terminal effects run", async () => {
    const { chat, emit, attach, live } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    const queued = chat.prompt("later");
    void queued.catch(() => undefined);
    live(1, { type: "session.request.asked", request: toolRequest, phase: "requires_action" });

    const views: unknown[] = [];
    const unsubscribe = chat.store.subscribe((view) => views.push(view));
    emit({ type: "closed", reason: "session_deleted" });
    unsubscribe();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      outgoing: [],
      session: {
        pendingRequests: [],
        historyStatus: "settled",
        status: "error",
        error: new Error("Session deleted"),
      },
    });
    await expect(queued).rejects.toThrow("Session is no longer available");
  });

  it("serializes inputs enqueued reentrantly from a store subscriber", async () => {
    const { chat, attach } = makeChat();
    await attach({});
    await chat.prompt("first");

    let reentered = false;
    let third: Promise<void> | undefined;
    const unsubscribe = chat.store.subscribe((view) => {
      if (
        !reentered &&
        view.outgoing.filter((message) => message.status === "queued").length === 1
      ) {
        reentered = true;
        third = chat.prompt("third");
        void third.catch(() => undefined);
      }
    });
    const second = chat.prompt("second");
    void second.catch(() => undefined);

    const queuedTexts = chat.store
      .getState()
      .outgoing.filter((message) => message.status === "queued")
      .map((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
    expect(queuedTexts).toEqual(["second", "third"]);

    unsubscribe();
    chat.dispose();
    await expect(second).rejects.toThrow("Chat disposed");
    await expect(third).rejects.toThrow("Chat disposed");
  });

  it("copies the crashed phase into an error status", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.crashed", reason: "boom", phase: "crashed" });
    expect(chat.store.getState().session.status).toBe("error");
  });

  it("dispatches the queued follow-up after the active runtime crashes", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    live(1, {
      type: "session.prompt.submitted",
      messageId: "remote-pending",
      parts: [{ type: "text", text: "waiting for harness" }],
      phase: "running",
    });
    const queued = chat.prompt("resume after crash");
    expect(transport.promptCalls).toEqual([]);

    live(2, { type: "session.crashed", reason: "boom", phase: "crashed" });
    await queued;

    expect(transport.promptCalls).toHaveLength(1);
    expect(transport.promptCalls[0]?.parts).toEqual([{ type: "text", text: "resume after crash" }]);
    expect(chat.store.getState().session.status).toBe("submitted");
  });

  it("clears pending requests when the session crashes", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.request.asked", request: toolRequest, phase: "requires_action" });
    expect(chat.store.getState().session.pendingRequests).toHaveLength(1);
    // The server projection drops its requests on crash; a surviving card
    // here could never be answered.
    live(2, { type: "session.crashed", reason: "boom", phase: "crashed" });
    expect(chat.store.getState().session.pendingRequests).toEqual([]);
  });

  it("enters a terminal error state when the session is deleted", async () => {
    const { chat, emit, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.request.asked", request: toolRequest, phase: "requires_action" });

    emit({ type: "closed", reason: "session_deleted" });
    expect(chat.store.getState().session.status).toBe("error");
    expect(chat.store.getState().session.error?.message).toBe("Session deleted");
    expect(chat.store.getState().session.pendingRequests).toEqual([]);

    // The terminal state is final: nothing may hydrate or fold over it.
    live(2, { type: "session.turn.started", turnId: "turn-late", phase: "running" });
    await attach({ status: { phase: "idle" } });
    expect(chat.store.getState().session.status).toBe("error");
  });

  it("names the close reason when the session was closed", async () => {
    const { chat, emit, attach } = makeChat();
    await attach({});
    emit({ type: "closed", reason: "session_closed" });
    expect(chat.store.getState().session.status).toBe("error");
    expect(chat.store.getState().session.error?.message).toBe("Session closed");
  });

  it("hands the owner a one-shot termination signal", async () => {
    let terminations = 0;
    const { emit, attach } = makeChat({ onTerminated: () => (terminations += 1) });
    await attach({});

    emit({ type: "closed", reason: "session_closed" });
    // A duplicate from the same dead stream is still one termination: the
    // owner has already released this Chat by then.
    emit({ type: "closed", reason: "session_deleted" });
    expect(terminations).toBe(1);
  });

  it("rejects the currently submitting prompt when the session terminates", async () => {
    const { chat, transport, emit, attach } = makeChat();
    await attach({});
    let releasePrompt: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const submitting = chat.prompt("in flight");
    await settle();

    emit({ type: "closed", reason: "session_deleted" });

    await expect(submitting).rejects.toThrow("Session is no longer available");
    releasePrompt();
    await settle();
    expect(chat.store.getState().session.error?.message).toBe("Session deleted");
  });

  it("rejects queued prompts when the session terminates", async () => {
    const { chat, emit, attach } = makeChat();
    await attach({
      status: { phase: "running" },
      activeTurn: activeTurn({ turnId: "turn-1", chunks: [] }),
    });
    const queued = chat.prompt("never sent");

    emit({ type: "closed", reason: "session_deleted" });

    await expect(queued).rejects.toThrow("Session is no longer available");
    expect(
      chat.store
        .getState()
        .outgoing.filter((message) => message.status === "queued")
        .map((message) => message.message),
    ).toEqual([]);
  });

  it("dispose rejects the submitting and waiting prompts without dispatching the tail", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({});
    let releasePrompt: () => void = () => undefined;
    transport.promptGate = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const submitting = chat.prompt("in flight");
    const waiting = chat.prompt("never sent");
    await settle();
    expect(transport.promptCalls).toHaveLength(1);

    chat.dispose();

    await expect(submitting).rejects.toThrow("Chat disposed");
    await expect(waiting).rejects.toThrow("Chat disposed");
    releasePrompt();
    await settle();
    expect(transport.promptCalls).toHaveLength(1);
    expect(transport.disposed).toBe(1);
  });
});
