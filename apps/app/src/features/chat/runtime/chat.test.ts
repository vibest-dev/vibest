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
  promptError: unknown = null;
  responded: Array<{ requestId: string; response: AgentResponse }> = [];

  subscribe(onEvent: (event: ChatTransportEvent) => void): () => void {
    this.onEvent = onEvent;
    return () => {
      this.disposed += 1;
    };
  }
  prompt = async (input: { messageId: string; parts: ReadonlyArray<PromptPart> }) => {
    this.promptCalls.push(input);
    if (this.promptError) throw this.promptError;
    return { turnId: "turn-receipt" };
  };
  getMessages = async () => {
    this.getMessagesCalls += 1;
    if (this.historyGate) await this.historyGate;
    return this.history;
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
    expect(chat.store.getState().messages).toHaveLength(1);

    transport.history = [userMessage("user-1", "hello")];
    await attach({ cursor: 0 });

    const [start, delta, end] = textChunks("t", "after the restart");
    for (const [seq, chunk] of [start!, delta!, end!].entries()) {
      live(seq + 1, { type: "session.message.chunk", turnId: "turn-1", chunk });
    }
    await settle();

    const last = chat.store.getState().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(assistantText(last)).toBe("after the restart");
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
    const messages = chat.store.getState().messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(assistantText(messages[1]!)).toBe("buffered");
    expect(chat.store.getState().status).toBe("streaming");
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
    const assistant = chat.store.getState().messages.at(-1)!;
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
    expect(chat.store.getState().messages).toHaveLength(2);
    expect(chat.store.getState().status).toBe("ready");
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
      activePrompt: { messageId: "m2", parts: [{ type: "text", text: "hi" }], seq: 11 },
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
    expect(state.pendingRequests.map((request) => request.id)).toEqual(["request-1"]);
    expect(state.status).toBe("streaming");
    expect(state.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1", "m2"]);
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
      activePrompt: { messageId: "m2", parts: [{ type: "text", text: "second" }], seq: 10 },
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
    expect(chat.store.getState().messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
  });

  it("replays the retained prompt so the user bubble lands above the streaming reply", async () => {
    const { chat, attach } = makeChat();
    const [start] = textChunks("t", "");
    await attach({
      status: { phase: "running" },
      activePrompt: { messageId: "prompt-1", parts: [{ type: "text", text: "run it" }], seq: 1 },
      activeTurn: activeTurn({
        turnId: "turn-1",
        chunks: [chunkEvent(2, "turn-1", start!)],
        complete: false,
        truncated: false,
      }),
      cursor: 2,
    });
    const messages = chat.store.getState().messages;
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
    expect(chat.store.getState().historyStatus).toBe("loading");
    await attach({});
    expect(chat.store.getState().historyStatus).toBe("loading");
    openGate();
    await settle();
    expect(chat.store.getState().historyStatus).toBe("settled");
  });

  // Both ways a read comes back with no floor — capability absent, read threw —
  // land on the same state: the transcript says so instead of showing a blank
  // that would read as "nothing was ever said".
  it("marks the history unavailable when the harness has no read", async () => {
    const { chat, transport, attach } = makeChat();
    transport.history = null;
    await attach({});
    expect(chat.store.getState().historyStatus).toBe("unavailable");
  });

  it("marks the history unavailable when the read fails", async () => {
    const { chat, transport, attach } = makeChat();
    transport.getMessages = async () => {
      throw new Error("rpc failed");
    };
    await attach({});
    expect(chat.store.getState().historyStatus).toBe("unavailable");
  });

  it("stops loading when the session terminates before any floor landed", async () => {
    const { chat, emit } = makeChat();
    emit({ type: "closed", reason: "session_deleted" });
    expect(chat.store.getState().historyStatus).toBe("settled");
  });
});

describe("Chat prompting", () => {
  it("pushes the optimistic message, submits fire-and-forget, and dedupes its echo", async () => {
    const { chat, transport, attach, live } = makeChat();
    await attach({});
    await chat.prompt("hello there");
    expect(transport.promptCalls).toHaveLength(1);
    const { messageId } = transport.promptCalls[0]!;
    expect(chat.store.getState().status).toBe("submitted");
    // The echo carries the pre-turn idle phase — it must not clear the
    // sender's optimistic "submitted".
    live(1, {
      type: "session.prompt.submitted",
      messageId,
      parts: [{ type: "text", text: "hello there" }],
      phase: "idle",
    });
    expect(chat.store.getState().messages).toHaveLength(1);
    expect(chat.store.getState().status).toBe("submitted");
    live(2, { type: "session.turn.started", turnId: "turn-1", phase: "running" });
    expect(chat.store.getState().status).toBe("streaming");
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
    const messages = chat.store.getState().messages;
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
    expect(chat.store.getState().messages).toHaveLength(1);
    // The harness rejected the prompt (turn already running): the compensating
    // event removes the user bubble everywhere, optimistic copy included.
    live(2, { type: "session.prompt.rejected", messageId, reason: "turn running", phase: "idle" });
    expect(chat.store.getState().messages).toEqual([]);
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
    const messages = chat.store.getState().messages;
    expect(messages).toHaveLength(2);
    expect(assistantText(messages[1]!)).toBe("reply");
    expect(chat.store.getState().status).toBe("ready");
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

    expect(chat.store.getState().error?.message).toBe(providerError);
    expect(chat.store.getState().status).toBe("ready");

    await chat.prompt("retry");
    expect(chat.store.getState().error).toBeUndefined();
    expect(chat.store.getState().status).toBe("submitted");
    expect(transport.promptCalls.at(-1)?.parts).toEqual([{ type: "text", text: "retry" }]);
  });

  it("restores an unseen provider error after its retained prompt boundary", async () => {
    const { chat, attach } = makeChat();
    const providerError = "Connection error.";
    await attach({ cursor: 1 });

    await attach({
      status: { phase: "idle" },
      activePrompt: { messageId: "prompt-1", parts: [{ type: "text", text: "go" }], seq: 2 },
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

    expect(chat.store.getState().error?.message).toBe(providerError);
  });

  it("lets a newer retained prompt clear an older completed-turn error", async () => {
    const { chat, attach } = makeChat();
    await attach({});
    chat.store.setState({ error: new Error("older local failure") });

    await attach({
      status: { phase: "idle" },
      activePrompt: {
        messageId: "prompt-new",
        parts: [{ type: "text", text: "try again" }],
        seq: 4,
      },
      activeTurn: activeTurn({
        turnId: "turn-old",
        chunks: [chunkEvent(2, "turn-old", { type: "error", errorText: "old provider error" })],
        complete: true,
      }),
      cursor: 4,
    });

    expect(chat.store.getState().error).toBeUndefined();
    expect(chat.store.getState().messages.at(-1)?.id).toBe("prompt-new");
  });

  it("clears a stale error for unseen broadcast and retained prompts", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    chat.store.setState({ error: new Error("old failure") });

    live(1, {
      type: "session.prompt.submitted",
      messageId: "remote-1",
      parts: [{ type: "text", text: "remote" }],
      phase: "idle",
    });
    expect(chat.store.getState().error).toBeUndefined();

    chat.store.setState({ error: new Error("another old failure") });
    await attach({
      status: { phase: "running" },
      activePrompt: { messageId: "remote-2", parts: [{ type: "text", text: "retained" }], seq: 2 },
      activeTurn: activeTurn({ turnId: "turn-2", chunks: [] }),
      cursor: 3,
    });
    expect(chat.store.getState().error).toBeUndefined();
  });

  it("does not let a delayed self-echo clear a prompt RPC failure", async () => {
    const { chat, transport, attach, live } = makeChat();
    const promptError = new Error("Prompt RPC failed");
    await attach({});
    transport.promptError = promptError;

    await expect(chat.prompt("go")).rejects.toThrow(promptError);
    const { messageId, parts } = transport.promptCalls[0]!;
    expect(chat.store.getState().error?.message).toBe(promptError.message);

    live(1, { type: "session.prompt.submitted", messageId, parts, phase: "idle" });
    expect(chat.store.getState().error?.message).toBe(promptError.message);
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
    expect(chat.store.getState().pendingRequests.map((r) => r.id)).toEqual(["request-1"]);
    const second: AgentRequest = { ...toolRequest, id: "request-2" };
    live(2, { type: "session.request.asked", request: second, phase: "requires_action" });
    expect(chat.store.getState().pendingRequests.map((r) => r.id)).toEqual([
      "request-1",
      "request-2",
    ]);
    live(3, { type: "session.request.replied", requestId: "request-1", phase: "requires_action" });
    expect(chat.store.getState().pendingRequests.map((r) => r.id)).toEqual(["request-2"]);
    // Re-attach: the snapshot is authoritative — stale local entries vanish.
    await attach({ pendingRequests: [], cursor: 3 });
    expect(chat.store.getState().pendingRequests).toEqual([]);
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
    expect(chat.store.getState().pendingRequests).toEqual([]);
  });

  it("drops unanswered requests when the turn ends", async () => {
    const { chat, attach, live } = makeChat();
    await attach({
      status: { phase: "requires_action" },
      pendingRequests: [toolRequest],
      cursor: 1,
    });
    live(2, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    expect(chat.store.getState().pendingRequests).toEqual([]);
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
    expect(chat.store.getState().messages.map((m) => m.id)).toEqual(["user-1", "assistant-1"]);
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
    expect(chat.store.getState().messages.map((m) => m.id)).toEqual(["user-1", "assistant-1"]);
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
    expect(chat.store.getState().messages.map((m) => m.id)).not.toEqual(["user-1"]);
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
    const assistant = chat.store.getState().messages.at(-1)!;
    expect(assistantText(assistant)).toBe("tail");
    // Turn end: the full turn (including the evicted head) comes back from
    // history.
    transport.history = [userMessage("user-1", "prompt"), userMessage("assistant-1", "full")];
    live(54, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    expect(transport.getMessagesCalls).toBe(2);
    expect(chat.store.getState().messages.map((m) => m.id)).toEqual(["user-1", "assistant-1"]);
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
    const assistant = chat.store.getState().messages.at(-1)!;
    expect(assistantText(assistant)).toBe("seen");
    transport.history = [userMessage("assistant-1", "whole turn")];
    live(12, { type: "session.turn.ended", turnId: "turn-1", outcome: "completed", phase: "idle" });
    await settle();
    expect(chat.store.getState().messages.map((m) => m.id)).toEqual(["assistant-1"]);
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
    expect(chat.store.getState().messages.map((m) => m.id)).toEqual(["assistant-1"]);
    void live;
  });
});

describe("Chat lifecycle", () => {
  it("copies the crashed phase into an error status", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.crashed", reason: "boom", phase: "crashed" });
    expect(chat.store.getState().status).toBe("error");
  });

  it("clears pending requests when the session crashes", async () => {
    const { chat, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.request.asked", request: toolRequest, phase: "requires_action" });
    expect(chat.store.getState().pendingRequests).toHaveLength(1);
    // The server projection drops its requests on crash; a surviving card
    // here could never be answered.
    live(2, { type: "session.crashed", reason: "boom", phase: "crashed" });
    expect(chat.store.getState().pendingRequests).toEqual([]);
  });

  it("enters a terminal error state when the session is deleted", async () => {
    const { chat, emit, attach, live } = makeChat();
    await attach({});
    live(1, { type: "session.request.asked", request: toolRequest, phase: "requires_action" });

    emit({ type: "closed", reason: "session_deleted" });
    expect(chat.store.getState().status).toBe("error");
    expect(chat.store.getState().error?.message).toBe("Session deleted");
    expect(chat.store.getState().pendingRequests).toEqual([]);

    // The terminal state is final: nothing may hydrate or fold over it.
    live(2, { type: "session.turn.started", turnId: "turn-late", phase: "running" });
    await attach({ status: { phase: "idle" } });
    expect(chat.store.getState().status).toBe("error");
  });

  it("names the close reason when the session was closed", async () => {
    const { chat, emit, attach } = makeChat();
    await attach({});
    emit({ type: "closed", reason: "session_closed" });
    expect(chat.store.getState().status).toBe("error");
    expect(chat.store.getState().error?.message).toBe("Session closed");
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

  it("dispose tears down the subscription and folds", async () => {
    const { chat, transport, attach } = makeChat();
    await attach({});
    chat.dispose();
    expect(transport.disposed).toBe(1);
  });
});
