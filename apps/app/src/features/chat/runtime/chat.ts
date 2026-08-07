import type {
  HarnessAgentId,
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionMessageChunkEvent,
  SessionPhase,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
} from "@vibest/contract";
import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { StoreApi } from "zustand/vanilla";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import { ChatState, type ChatStoreState } from "./chat-state";
import type { ChatSessionTransport } from "./chat-transport-port";
import { sanitizeTail } from "./sanitize-tail";

export interface ChatInit {
  sessionRef: SessionRef;
  transport: ChatSessionTransport;
  /**
   * Fired once, when the server declares this session's stream over for good
   * (closed or deleted). The owner's cue to stop caching this Chat — the
   * instance stays usable for whoever is currently rendering it, showing the
   * terminal error, and is simply never handed out again.
   */
  onTerminated?: () => void;
}

// Runtime phase → AI-SDK chat status. "submitted" is a sender-local optimistic
// state (set in prompt(), cleared by the next server-stamped phase) and never
// comes from the server.
function statusFromPhase(phase: SessionPhase): "streaming" | "ready" | "error" {
  switch (phase) {
    case "idle":
      return "ready";
    case "crashed":
      return "error";
    // requires_action keeps "streaming": the turn is still open, the composer
    // stays blocked either way.
    default:
      return "streaming";
  }
}

/** Wire prompt parts → the user UIMessage every client renders. */
const toUserMessage = (messageId: string, parts: ReadonlyArray<PromptPart>): UIMessage => ({
  id: messageId,
  role: "user",
  parts: parts.map((part) =>
    part.type === "data-inspector" ? { type: "data-inspector", data: part.data } : part,
  ) as UIMessage["parts"],
});

// One turn's chunk sink: chunks are pushed in as they arrive and the AI-SDK's
// own reducer (readUIMessageStream — the same machinery the server-side
// history folds use) turns them into evolving UIMessage snapshots.
type TurnFold = {
  readonly enqueue: (chunk: UIMessageChunk) => void;
  readonly close: () => void;
};

// Session controller, single-consumer: every message — this client's own
// turns included — folds out of the one persistent subscription, so all
// clients run the identical rendering path and none needs to claim turns.
// Sending is fire-and-forget: prompt() pushes the optimistic user message and
// submits the RPC; the turn's content comes back through the subscription
// like everyone else's.
//
// State sync vs increments: the transport's "attached" snapshot replaces
// wholesale what the server owns (pending requests, phase) and replays the
// active turn's retained buffer; live events are increments on top, gated by
// `seq > cursor` so the overlap around an attach never double-folds.
export class Chat {
  // A Chat is bound to one harness for its whole life (a session's harness
  // never changes), so tool rendering dispatches on it. Only claude-code and
  // codex have dedicated renderers; any other harness falls back to the
  // generic tool card.
  readonly harnessAgentId: HarnessAgentId;
  readonly store: StoreApi<ChatStoreState>;
  readonly #state: ChatState;
  readonly #transport: ChatSessionTransport;
  readonly #onTerminated: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  readonly #turnFolds = new Map<string, TurnFold>();
  // Turns whose live rendering was abandoned (buffer truncated, replay gap):
  // their chunks are skipped and the turn is recovered from the history read
  // once it ends.
  readonly #recoverTurnIds = new Set<string>();
  // Turns whose stream carried an error chunk: the harness may retry
  // internally and still complete, with the retried tail persisted but never
  // streamed — reconcile from history at turn end regardless of outcome.
  readonly #erroredTurnIds = new Set<string>();
  #cursor = 0;
  #historyLoaded = false;
  // Non-null while the history floor is loading: live events queue here so
  // nothing folds ahead of the floor. Drained (in order, cursor-gated) once
  // the floor and the snapshot hydration are down.
  #queuedEvents: SessionScopedEvent[] | null = null;
  // The snapshot the floor's hydration will use. A re-attach while the floor
  // is still loading replaces it, so hydration always folds the freshest
  // server state — never a stale first snapshot over a newer one.
  #floorSnapshot: SessionRuntimeSnapshot | null = null;
  // The live view is known to miss settled content (a turn completed inside a
  // subscription drop, a fold whose tail streamed while detached): re-read
  // history at the next safe point. Cleared when a reconcile lands.
  #needsReconcile = false;

  // Set when the session was closed or deleted server-side: the subscription
  // has stopped for good, and nothing may overwrite the terminal state — an
  // in-flight history-floor read completing late would otherwise re-hydrate
  // over it.
  #terminated = false;

  constructor({ sessionRef, transport, onTerminated }: ChatInit) {
    this.harnessAgentId = sessionRef.harnessAgentId;
    this.#state = new ChatState();
    this.store = this.#state.store;
    this.#transport = transport;
    this.#onTerminated = onTerminated;
    this.#unsubscribe = transport.subscribe((event) => {
      if (event.type === "attached") this.#hydrate(event.snapshot);
      else if (event.type === "closed") this.#terminate(event.reason);
      else if (this.#queuedEvents) this.#queuedEvents.push(event);
      else this.#apply(event);
    });
  }

  // ---------------------------------------------------------------------
  // Event application (increments)
  // ---------------------------------------------------------------------

  #apply(event: SessionScopedEvent): void {
    if (this.#terminated) return;
    if (event.seq <= this.#cursor) return;
    this.#cursor = event.seq;
    switch (event.type) {
      case "session.message.chunk":
        this.#captureChunkError(event.chunk);
        if (!this.#recoverTurnIds.has(event.turnId)) {
          if (event.chunk.type === "error") this.#erroredTurnIds.add(event.turnId);
          this.#turnFold(event.turnId).enqueue(event.chunk);
        }
        break;
      // Another client's prompt — or this client's own echoed back, whose
      // optimistic message already carries the same id, making the append a
      // no-op.
      case "session.prompt.submitted":
        // The sender already cleared its stale error synchronously in prompt().
        // Only a genuinely unseen prompt may clear here: a delayed self-echo
        // must not erase a newer prompt RPC failure.
        if (this.#pushUserMessage(event.messageId, event.parts)) this.#state.error = undefined;
        break;
      // The harness rejected a prompt whose submitted event already broadcast:
      // drop the phantom user message (the sender's optimistic copy included).
      case "session.prompt.rejected":
        this.#state.messages = this.#state.messages.filter(
          (message) => message.id !== event.messageId,
        );
        break;
      case "session.turn.started":
        break;
      case "session.turn.ended":
        this.#turnFolds.get(event.turnId)?.close();
        this.#turnFolds.delete(event.turnId);
        // Unanswered requests are stale once the turn ends — no ghost cards.
        this.#state.clearPendingRequests();
        // The settled transcript may hold more than the live stream carried:
        // a non-completed turn can have persisted partial (or internally
        // retried full) output, and an abandoned turn was never rendered
        // live at all.
        if (
          event.outcome !== "completed" ||
          this.#recoverTurnIds.has(event.turnId) ||
          this.#erroredTurnIds.has(event.turnId) ||
          // A reconcile deferred earlier (skipped mid-stream) retries at the
          // next turn boundary, when the replace is safe again.
          this.#needsReconcile
        ) {
          void this.#reconcileHistory();
        }
        this.#recoverTurnIds.delete(event.turnId);
        this.#erroredTurnIds.delete(event.turnId);
        break;
      case "session.request.asked":
        this.#handleRequest(event.request);
        break;
      case "session.request.replied":
      case "session.request.rejected":
        this.#state.removePendingRequest(event.requestId);
        break;
      case "session.crashed":
        for (const fold of this.#turnFolds.values()) fold.close();
        this.#turnFolds.clear();
        // The server projection drops its pending requests on crash; a card
        // left behind here could never be answered.
        this.#state.clearPendingRequests();
        break;
    }
    // Status is copied off the event (the runtime stamps its post-event
    // phase), never derived from event types here. Lifecycle events only:
    // chunk phases are redundant, and the prompt events carry a phase the
    // sender's optimistic "submitted" / error state must outlive — copying
    // it would wipe that local state before turn.started (or the prompt
    // RPC's own rejection) lands.
    if (
      event.phase !== undefined &&
      event.type !== "session.message.chunk" &&
      event.type !== "session.prompt.submitted" &&
      event.type !== "session.prompt.rejected"
    ) {
      this.#setStatus(statusFromPhase(event.phase));
    }
  }

  // The stream ended for good: the session was closed or deleted server-side,
  // so the runtime is gone and prompting or answering could only fail. Enter
  // the same terminal shape a crash does, with the reason on the error.
  #terminate(reason: "session_closed" | "session_deleted"): void {
    // A second `closed` would re-enter with the same terminal shape, but
    // `onTerminated` is a one-shot handover — its owner may already have let
    // this instance go.
    if (this.#terminated) return;
    this.#terminated = true;
    for (const fold of this.#turnFolds.values()) fold.close();
    this.#turnFolds.clear();
    this.#queuedEvents = null;
    // Terminal before the floor ever landed (or attached): no history is coming,
    // so stop rendering a spinner that would never resolve.
    this.#state.historyStatus = "settled";
    this.#state.clearPendingRequests();
    this.#state.error = new Error(
      reason === "session_deleted" ? "Session deleted" : "Session closed",
    );
    this.#setStatus("error");
    this.#onTerminated?.();
  }

  // ---------------------------------------------------------------------
  // Hydration (state sync at attach / re-attach)
  // ---------------------------------------------------------------------

  #hydrate(snapshot: SessionRuntimeSnapshot): void {
    // The settled-history floor, once per Chat life, strictly before anything
    // folds on top: live events queue while the read is in flight.
    if (!this.#historyLoaded) {
      this.#historyLoaded = true;
      this.#queuedEvents = [];
      this.#floorSnapshot = snapshot;
      void this.#loadHistoryFloor();
      return;
    }
    if (this.#queuedEvents !== null) {
      // Re-attach while the floor is still loading: the fresher snapshot
      // supersedes the one the floor started with. Hydration happens once,
      // from the latest — hydrating now and again on floor completion would
      // let the stale first snapshot win.
      this.#floorSnapshot = snapshot;
      return;
    }
    this.#hydrateFromSnapshot(snapshot);
  }

  async #loadHistoryFloor(): Promise<void> {
    try {
      const history = await this.#transport.getMessages();
      // Guarded on the transcript, not on status: a non-empty transcript is
      // already ahead of the disk (optimistic prompt), while a server-side
      // active turn just means another client is mid-turn — exactly when the
      // floor is still wanted.
      if (history !== null && history.length > 0 && this.#state.messages.length === 0) {
        this.#state.messages = Array.from(history);
      }
      // An empty read is still a floor: the session simply has nothing settled
      // yet. Only the absent capability (null) leaves the transcript unfounded.
      this.#state.historyStatus = history === null ? "unavailable" : "settled";
    } catch (historyError) {
      console.error("Failed to load session history", historyError);
      // A failed read is still a finished one — the spinner has to stop — but an
      // unannotated blank would claim the session is empty. A later reconcile
      // clears this when the read succeeds.
      this.#state.historyStatus = "unavailable";
    }
    const snapshot = this.#floorSnapshot;
    this.#floorSnapshot = null;
    // The floor read itself just fetched settled history, so the gap check
    // would only re-read what this hydration already has.
    if (snapshot) this.#hydrateFromSnapshot(snapshot, { skipGapCheck: true });
    const queued = this.#queuedEvents ?? [];
    this.#queuedEvents = null;
    for (const event of queued) this.#apply(event);
  }

  #hydrateFromSnapshot(
    snapshot: SessionRuntimeSnapshot,
    options?: { readonly skipGapCheck?: boolean },
  ): void {
    if (this.#terminated) return;
    // A snapshot below our cursor means the server's seq counter restarted —
    // its in-memory session was rebuilt (a server restart, or a close and
    // reopen). Nothing else can produce it: within one incarnation the counter
    // only grows, and an attach applies its snapshot before folding any live
    // event of that cycle. Keeping the old cursor would silently discard the
    // whole next turn as "already applied", so rejoin as a newcomer and let
    // the settled transcript supply what came before.
    if (snapshot.cursor < this.#cursor) {
      this.#cursor = 0;
      this.#needsReconcile = true;
    }
    // Pending requests are server state: replace wholesale, no diffing.
    this.#state.setPendingRequests([]);
    for (const request of snapshot.pendingRequests) this.#handleRequest(request);

    const activeTurn = snapshot.activeTurn;

    // A fold whose turn is no longer active ended while we were detached —
    // its turn.ended will never arrive, so nothing else closes it (and an
    // open fold blocks the reconcile guard below). Its tail streamed while
    // we were gone, so only the settled transcript still has it.
    for (const [turnId, fold] of this.#turnFolds) {
      if (activeTurn?.turnId !== turnId) {
        fold.close();
        this.#turnFolds.delete(turnId);
        this.#needsReconcile = true;
      }
    }
    // On first attach (cursor 0) a buffer marked complete is history, not
    // recovery — the floor covers it, and replaying would float a stale
    // reply above the transcript.
    const stale = this.#cursor === 0 && activeTurn?.complete === true;

    // The retained prompt is the only recovery for a `prompt.submitted`
    // missed while detached (events are never re-sent). A complete turn is
    // normally stale on first attach, except when the retained prompt itself
    // is the snapshot's latest event: then it belongs to the next, not-yet-
    // started turn and must render above the settled history floor.
    const activePrompt = snapshot.activePrompt;
    let appliedPromptSeq: number | undefined;
    if (
      activePrompt &&
      activePrompt.seq > this.#cursor &&
      (!stale || activePrompt.seq === snapshot.cursor)
    ) {
      appliedPromptSeq = activePrompt.seq;
      if (this.#pushUserMessage(activePrompt.messageId, activePrompt.parts)) {
        this.#state.error = undefined;
      }
    }

    // Error text is not part of the settled transcript floor. Only the latest
    // unseen error matters, but compare its seq with the retained prompt: the
    // runtime can hold a completed old turn beside a newer submitted prompt.
    // In that shape the prompt clears the old error rather than resurrecting
    // it; an error after the prompt belongs to the new turn and wins.
    let latestError: SessionMessageChunkEvent | undefined;
    for (const chunkEvent of activeTurn?.chunks ?? []) {
      if (chunkEvent.seq > this.#cursor && chunkEvent.chunk.type === "error") {
        latestError = chunkEvent;
      }
    }
    if (latestError && (appliedPromptSeq === undefined || latestError.seq > appliedPromptSeq)) {
      this.#captureChunkError(latestError.chunk);
    }

    // A turn flagged for recovery that is no longer active ended while we
    // were detached — its turn.ended (and the reconcile it would have
    // triggered) is gone.
    for (const turnId of this.#recoverTurnIds) {
      if (activeTurn?.turnId !== turnId) {
        this.#recoverTurnIds.delete(turnId);
        this.#erroredTurnIds.delete(turnId);
        this.#needsReconcile = true;
      }
    }

    // The snapshot retains only the latest prompt and the current turn's
    // buffer. If the seq gap since our cursor starts before anything the
    // snapshot retains, whole events — typically an entire completed turn —
    // fell inside the drop, and only the settled transcript still has them.
    if (!options?.skipGapCheck && snapshot.cursor > this.#cursor) {
      const retainedFloor = Math.min(
        activePrompt?.seq ?? Infinity,
        !stale && activeTurn ? (activeTurn.chunks[0]?.seq ?? Infinity) : Infinity,
      );
      if (retainedFloor > this.#cursor + 1) this.#needsReconcile = true;
    }

    if (activeTurn && !stale) this.#replayActiveTurn(activeTurn);

    if (this.#needsReconcile) void this.#reconcileHistory();

    this.#cursor = Math.max(this.#cursor, snapshot.cursor);
    this.#setStatus(statusFromPhase(snapshot.status.phase));
  }

  #replayActiveTurn(activeTurn: NonNullable<SessionRuntimeSnapshot["activeTurn"]>): void {
    const unseen = activeTurn.chunks.filter((chunkEvent) => chunkEvent.seq > this.#cursor);
    const head = activeTurn.chunks[0];
    // A truncated buffer lost its head. A fresh joiner (cursor 0) can still
    // watch the tail live — orphan continuation chunks are filtered so the
    // fold starts clean, and the reconcile at turn end backfills the missing
    // beginning. A returning viewer whose last-seen seq doesn't reach the
    // retained head has a hole in the *middle* — splicing the tail on would
    // fabricate a seamless-looking transcript, so it abandons the live view
    // and recovers the whole turn at its end instead.
    const contiguous = head !== undefined && head.seq <= this.#cursor + 1;
    let chunks: UIMessageChunk[];
    if (!activeTurn.truncated || contiguous) {
      chunks = unseen.map((chunkEvent) => chunkEvent.chunk);
    } else if (this.#cursor === 0) {
      chunks = sanitizeTail(unseen.map((chunkEvent) => chunkEvent.chunk));
      this.#recoverTurnIds.add(activeTurn.turnId);
    } else if (activeTurn.complete) {
      void this.#reconcileHistory();
      return;
    } else {
      this.#recoverTurnIds.add(activeTurn.turnId);
      return;
    }
    for (const chunk of chunks) {
      if (chunk.type === "error") this.#erroredTurnIds.add(activeTurn.turnId);
      this.#turnFold(activeTurn.turnId).enqueue(chunk);
    }
    if (activeTurn.complete) {
      this.#turnFolds.get(activeTurn.turnId)?.close();
      this.#turnFolds.delete(activeTurn.turnId);
      // Two statements, not `a || b`: both sets must drop the turn, and the
      // short-circuit would leave the second entry behind.
      const recovered = this.#recoverTurnIds.delete(activeTurn.turnId);
      const errored = this.#erroredTurnIds.delete(activeTurn.turnId);
      if (recovered || errored) void this.#reconcileHistory();
    }
  }

  // ---------------------------------------------------------------------
  // Shared handlers
  // ---------------------------------------------------------------------

  #captureChunkError(chunk: UIMessageChunk): void {
    if (chunk.type === "error") this.#state.error = new Error(chunk.errorText);
  }

  #pushUserMessage(messageId: string, parts: ReadonlyArray<PromptPart>): boolean {
    if (this.#state.messages.some((message) => message.id === messageId)) return false;
    this.#state.pushMessage(toUserMessage(messageId, parts));
    return true;
  }

  // Policy, not transport: an empty plan carries nothing to review, so it is
  // approved on sight instead of surfacing a blank card.
  #handleRequest(request: AgentRequest): void {
    if (request.type === "plan" && !request.plan.trim()) {
      void this.#transport
        .respondToAgentRequest(request.id, { type: "plan", behavior: "allow" })
        .catch((error: unknown) => {
          console.error("Failed to auto-approve empty plan request", error);
          this.#state.addPendingRequest(request);
        });
      return;
    }
    this.#state.addPendingRequest(request);
  }

  // The live view may have diverged from the settled transcript — re-read
  // history and replace, when it is safe: a fresh turn's optimistic message
  // or streaming chunks must not be clobbered. A skipped reconcile converges
  // on the next reload instead.
  async #reconcileHistory(): Promise<void> {
    try {
      const history = await this.#transport.getMessages();
      // Same read as the floor's, so it answers the same question: a reconcile
      // that lands clears a floor read that failed earlier.
      this.#state.historyStatus = history === null ? "unavailable" : "settled";
      if (history === null) {
        // Capability absent: no settled transcript will ever materialize, so
        // a deferred reconcile must not retry forever.
        this.#needsReconcile = false;
        return;
      }
      if (history.length === 0) return;
      if (this.#state.status === "streaming" || this.#state.status === "submitted") return;
      if (this.#turnFolds.size > 0) return;
      this.#state.messages = Array.from(history);
      this.#needsReconcile = false;
    } catch (reconcileError) {
      console.error("Failed to reconcile session history", reconcileError);
    }
  }

  #turnFold(turnId: string): TurnFold {
    const existing = this.#turnFolds.get(turnId);
    if (existing) return existing;
    let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        controller = c;
      },
    });
    void (async () => {
      try {
        // Seed the fold with a turn-derived id: a start chunk that carries no
        // messageId (claude-code) would otherwise leave the reader's constant
        // default id on every folded message, and two turns would upsert into
        // each other's slot. A start chunk that does carry one (pi) still
        // overrides this seed.
        const seed = { id: `turn-${turnId}`, role: "assistant", parts: [] } as UIMessage;
        for await (const message of readUIMessageStream({ message: seed, stream })) {
          this.#state.upsertMessage(message as UIMessage);
        }
      } catch (foldError) {
        console.error("Failed to fold turn", foldError);
      }
    })();
    let closed = false;
    const fold: TurnFold = {
      enqueue: (chunk) => {
        if (!closed) controller?.enqueue(chunk);
      },
      close: () => {
        if (closed) return;
        closed = true;
        controller?.close();
      },
    };
    this.#turnFolds.set(turnId, fold);
    return fold;
  }

  #setStatus(status: "submitted" | "streaming" | "ready" | "error"): void {
    if (this.#state.status !== status) this.#state.status = status;
  }

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  // Fire-and-forget: push the optimistic user message, submit the RPC, and
  // let the subscription carry the reply back like any other client's turn.
  prompt = async (text: string): Promise<void> => {
    const messageId = generateId();
    const parts: PromptPart[] = [{ type: "text", text }];
    this.#state.error = undefined;
    this.#state.pushMessage(toUserMessage(messageId, parts));
    this.#setStatus("submitted");
    try {
      await this.#transport.prompt({ messageId, parts });
    } catch (promptError) {
      this.#state.error =
        promptError instanceof Error ? promptError : new Error(String(promptError));
      this.#setStatus("error");
      throw promptError;
    }
  };

  // Model / reasoningEffort / permission are session config, changed via their
  // own calls — never bundled into a prompt turn.
  setModel = async (providerId: string, modelId: string): Promise<void> => {
    await this.#transport.setModel(providerId, modelId);
  };

  setReasoningEffort = async (reasoningEffort: ReasoningEffort): Promise<void> => {
    await this.#transport.setReasoningEffort(reasoningEffort);
  };

  setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    await this.#transport.setPermissionMode(mode);
  };

  respondToAgentRequest = async (requestId: string, response: AgentResponse): Promise<void> => {
    const request = this.store.getState().pendingRequests.find((r) => r.id === requestId);
    this.#state.removePendingRequest(requestId); // optimistic: the card closes immediately
    try {
      await this.#transport.respondToAgentRequest(requestId, response);
    } catch (respondError) {
      // Failure = the request is still pending server-side: restore the card so
      // the user can answer again (addPendingRequest is idempotent by id).
      console.error("Failed to respond to agent request", respondError);
      if (request) this.#state.addPendingRequest(request);
    }
  };

  dispose = (): void => {
    this.#unsubscribe();
    for (const fold of this.#turnFolds.values()) fold.close();
    this.#turnFolds.clear();
  };
}
