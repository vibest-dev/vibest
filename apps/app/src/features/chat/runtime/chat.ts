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
import { ClientPromptQueue, type ClientQueuedPrompt } from "./client-prompt-queue";
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
// Sending is serialized through a client-local FIFO. `prompt()` returns a
// promise that settles when that item reaches the head and its RPC settles;
// the turn's content still comes back through the subscription like everyone
// else's. The queue intentionally lives only for this Chat's lifetime.
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
  readonly #promptQueue: ClientPromptQueue;
  // Prompts whose RPC has not settled. A call made after the socket drops can
  // wait inside oRPC's reconnect loop until the restarted server is reachable;
  // snapshots and settled history received meanwhile may not account for it.
  readonly #promptsInFlight = new Set<string>();
  // Invalidates a history read that overlaps a prompt, even when that prompt
  // settles before the older read returns.
  #promptRevision = 0;
  // Latest snapshot phase held back while a prompt is invisible to that
  // snapshot. Applied when the final successful prompt RPC settles, unless a
  // newer lifecycle event has already supplied a phase.
  #deferredSnapshotPhase: SessionPhase | null = null;
  // Whether submitting a new prompt would start a fresh turn. This is stricter
  // than UI status: an idle session can still hold a submitted prompt that the
  // harness has not accepted yet, while a crashed runtime can accept a resume.
  #promptBoundaryOpen = false;
  readonly #pendingPromptMessageIds = new Set<string>();
  #lastEndedTurnId: string | null = null;
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
  #disposed = false;

  constructor({ sessionRef, transport, onTerminated }: ChatInit) {
    this.harnessAgentId = sessionRef.harnessAgentId;
    this.#state = new ChatState();
    this.store = this.#state.store;
    this.#promptQueue = new ClientPromptQueue(this.#state.setQueuedMessages);
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
      case "session.prompt.submitted":
        this.#pendingPromptMessageIds.add(event.messageId);
        this.#promptBoundaryOpen = false;
        break;
      case "session.prompt.accepted":
        if (!this.#pendingPromptMessageIds.delete(event.messageId)) break;
        // The manager's direct acceptance emit can beat the adapter's queued
        // turn.started event. Idle is safe only when this exact turn already
        // ended; otherwise wait for its lifecycle events.
        this.#promptBoundaryOpen =
          this.#pendingPromptMessageIds.size === 0 &&
          (event.phase === "crashed" ||
            (event.phase === "idle" && this.#lastEndedTurnId === event.turnId));
        break;
      case "session.prompt.rejected":
        if (!this.#pendingPromptMessageIds.delete(event.messageId)) break;
        this.#promptBoundaryOpen =
          this.#pendingPromptMessageIds.size === 0 &&
          (event.phase === "idle" || event.phase === "crashed");
        break;
      case "session.turn.started":
        this.#promptBoundaryOpen = false;
        break;
      case "session.turn.ended":
        this.#lastEndedTurnId = event.turnId;
        this.#promptBoundaryOpen =
          this.#pendingPromptMessageIds.size === 0 &&
          (event.phase === "idle" || event.phase === "crashed");
        break;
      case "session.crashed":
        // Crash discards activePrompt and activeTurn in the server projection.
        this.#pendingPromptMessageIds.clear();
        this.#lastEndedTurnId = null;
        this.#promptBoundaryOpen = true;
        break;
      default:
        if (event.phase === "running" || event.phase === "requires_action") {
          this.#promptBoundaryOpen = false;
        }
        break;
    }
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
      case "session.prompt.accepted":
        break;
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
      event.type !== "session.prompt.accepted" &&
      event.type !== "session.prompt.rejected"
    ) {
      this.#deferredSnapshotPhase = null;
      this.#setStatus(statusFromPhase(event.phase));
    }
    this.#maybeDispatchPrompt();
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
    this.#rejectLocalPromptQueue(new Error("Session is no longer available"));
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
    // Hydration called the queue gate while events were still buffered. Once
    // the floor is complete, an idle snapshot can release an early prompt.
    this.#maybeDispatchPrompt();
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
    const acceptedPrompt =
      snapshot.acceptedPrompt ?? (activePrompt?.acceptedTurnId !== null ? activePrompt : null);
    const acceptedPromptBelongsToStaleTurn =
      stale && acceptedPrompt?.acceptedTurnId === activeTurn?.turnId;
    const promptCandidates = [
      ...(acceptedPrompt && !acceptedPromptBelongsToStaleTurn ? [acceptedPrompt] : []),
      ...snapshot.pendingPrompts,
    ].filter(
      (prompt, index, prompts) =>
        prompts.findIndex((candidate) => candidate.messageId === prompt.messageId) === index,
    );
    const retainedPrompts = promptCandidates.reduce<typeof promptCandidates>((ordered, prompt) => {
      const insertionIndex = ordered.findIndex((candidate) => candidate.seq > prompt.seq);
      if (insertionIndex === -1) ordered.push(prompt);
      else ordered.splice(insertionIndex, 0, prompt);
      return ordered;
    }, []);
    let appliedPromptSeq: number | undefined;
    for (const prompt of retainedPrompts) {
      if (prompt.seq <= this.#cursor) continue;
      appliedPromptSeq = Math.max(appliedPromptSeq ?? 0, prompt.seq);
      if (this.#pushUserMessage(prompt.messageId, prompt.parts)) {
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
        ...retainedPrompts.map((prompt) => prompt.seq),
        !stale && activeTurn ? (activeTurn.chunks[0]?.seq ?? Infinity) : Infinity,
      );
      if (retainedFloor > this.#cursor + 1) this.#needsReconcile = true;
    }

    if (activeTurn && !stale) this.#replayActiveTurn(activeTurn);

    if (this.#needsReconcile) void this.#reconcileHistory();

    this.#cursor = Math.max(this.#cursor, snapshot.cursor);
    // A prompt still waiting on the wire is invisible to this snapshot. Keep
    // the sender-local submitted state, but retain the latest phase so a turn
    // that completed before the unary receipt can converge when the RPC settles.
    const snapshotLastEndedTurnId = activeTurn?.complete ? activeTurn.turnId : null;
    const snapshotBoundaryOpen =
      snapshot.pendingPrompts.length === 0 &&
      (snapshot.status.phase === "crashed" ||
        (snapshot.status.phase === "idle" &&
          (acceptedPrompt === null ||
            (acceptedPrompt.acceptedTurnId !== null &&
              activeTurn?.complete === true &&
              activeTurn.turnId === acceptedPrompt.acceptedTurnId))));
    if (this.#promptsInFlight.size === 0) {
      this.#pendingPromptMessageIds.clear();
      for (const prompt of snapshot.pendingPrompts) {
        this.#pendingPromptMessageIds.add(prompt.messageId);
      }
      this.#lastEndedTurnId = snapshotLastEndedTurnId;
      this.#promptBoundaryOpen = snapshotBoundaryOpen;
      this.#deferredSnapshotPhase = null;
      this.#setStatus(statusFromPhase(snapshot.status.phase));
    } else {
      // acceptedPrompt remains visible even when a newer unresolved candidate
      // masks it in activePrompt, so reconnect can still settle this client's
      // in-flight correlation without retaining a stale local id forever.
      const accountsForPendingPrompt =
        this.#promptsInFlight.size === 1 &&
        acceptedPrompt !== null &&
        acceptedPrompt.acceptedTurnId !== null &&
        this.#promptsInFlight.has(acceptedPrompt.messageId);
      if (accountsForPendingPrompt) {
        this.#pendingPromptMessageIds.clear();
        this.#lastEndedTurnId = snapshotLastEndedTurnId;
      }
      for (const prompt of snapshot.pendingPrompts) {
        this.#pendingPromptMessageIds.add(prompt.messageId);
      }
      this.#promptBoundaryOpen = accountsForPendingPrompt && snapshotBoundaryOpen;
      this.#deferredSnapshotPhase =
        accountsForPendingPrompt && (snapshot.status.phase !== "idle" || snapshotBoundaryOpen)
          ? snapshot.status.phase
          : null;
    }
    this.#maybeDispatchPrompt();
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
    // Settled history cannot contain a prompt that has not reached the server.
    // Leave #needsReconcile set so a later turn boundary or attach retries it.
    if (this.#promptsInFlight.size > 0) return;
    const promptRevision = this.#promptRevision;
    try {
      const history = await this.#transport.getMessages();
      // The read is stale if a prompt began while it was in flight — including
      // the case where that prompt settled before this older response arrived.
      if (promptRevision !== this.#promptRevision || this.#promptsInFlight.size > 0) return;
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

  #resumeAfterPromptSettlement(): void {
    const phase = this.#deferredSnapshotPhase;
    this.#deferredSnapshotPhase = null;
    if (phase !== null) this.#setStatus(statusFromPhase(phase));
    if (this.#needsReconcile) void this.#reconcileHistory();
  }

  #maybeDispatchPrompt(): void {
    if (
      this.#terminated ||
      this.#disposed ||
      this.#promptQueue.isDispatching ||
      !this.#historyLoaded ||
      this.#queuedEvents !== null ||
      !this.#promptBoundaryOpen ||
      !this.#promptQueue.hasWaiting
    ) {
      return;
    }
    const dispatch = this.#promptQueue.dispatchNext((prompt) => this.#submitPrompt(prompt));
    if (dispatch) void dispatch.finally(() => this.#maybeDispatchPrompt());
  }

  async #submitPrompt(item: ClientQueuedPrompt): Promise<void> {
    const messageId = item.message.id;
    this.#pendingPromptMessageIds.add(messageId);
    this.#promptBoundaryOpen = false;
    this.#promptRevision += 1;
    this.#promptsInFlight.add(messageId);
    this.#state.error = undefined;
    this.#state.pushMessage(item.message);
    this.#setStatus("submitted");
    try {
      await this.#transport.prompt({ messageId, parts: item.parts });
    } catch (promptError) {
      if (!this.#terminated && !this.#disposed) {
        this.#state.error =
          promptError instanceof Error ? promptError : new Error(String(promptError));
        this.#deferredSnapshotPhase = null;
        this.#setStatus("error");
      }
      throw promptError;
    } finally {
      this.#promptsInFlight.delete(messageId);
      if (
        !this.#terminated &&
        !this.#disposed &&
        this.#promptsInFlight.size === 0 &&
        this.#state.status !== "error"
      ) {
        this.#resumeAfterPromptSettlement();
      }
    }
  }

  #rejectLocalPromptQueue(error: Error): void {
    this.#promptQueue.rejectAll(error);
  }

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  // Enqueue locally. The returned promise settles only when this item reaches
  // the head and the server prompt RPC settles; queued items remain visible in
  // a separate store slice so history reconciliation cannot erase them.
  prompt = (text: string): Promise<void> => {
    if (this.#terminated) return Promise.reject(new Error("Session is no longer available"));
    if (this.#disposed) return Promise.reject(new Error("Chat disposed"));
    const parts: PromptPart[] = [{ type: "text", text }];
    const message = toUserMessage(generateId(), parts);
    const submitted = this.#promptQueue.enqueue({ message, parts });
    this.#maybeDispatchPrompt();
    return submitted;
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
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#rejectLocalPromptQueue(new Error("Chat disposed"));
    for (const fold of this.#turnFolds.values()) fold.close();
    this.#turnFolds.clear();
  };
}
