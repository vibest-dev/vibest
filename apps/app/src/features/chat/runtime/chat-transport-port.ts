import type {
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
} from "@vibest/contract";
import type { UIMessage } from "ai";

import type { AgentResponse } from "./agent-requests";

// The seam between Chat orchestration and any concrete wire implementation.
// Chat and ChatManager depend only on this port; the oRPC binding
// (OrpcChatSessionTransport) implements it and is injected at the composition
// root, so nothing in the core knows about oRPC or the WebSocket client.
//
// The vocabulary is the server's own (`@vibest/contract`): the transport adds
// no event language of its own. Its sole synthetic variant is "attached" —
// the one occurrence the server has no event for, because for the server a
// snapshot is a query, not something that happens.

/**
 * What the subscription delivers: the wire events verbatim, plus an
 * "attached" marker carrying the snapshot taken at (re)connect.
 *
 * State sync vs increments: an "attached" snapshot is the authoritative state
 * at that moment (pending requests to replace wholesale, the active turn's
 * retained buffer, the phase); the events that follow are increments on top.
 * After a connection drop the transport re-attaches and emits a fresh
 * "attached" — consumers reconcile against the snapshot, never against
 * replayed events (live events are broadcast once and never re-sent).
 *
 * Delivery is seq-agnostic: the transport does not gate. Buffered chunks
 * inside the snapshot and live events may overlap around the attach point;
 * the consumer holds the cursor and drops what it has already folded.
 *
 * "closed" is attached's terminal counterpart, in the server's own words
 * (the stream's close reason, verbatim): the session was closed or deleted,
 * the runtime is gone, and the subscription has stopped for good — no
 * further "attached" will follow. Recoverable close reasons (slow_consumer)
 * never surface here; the transport re-attaches through them silently.
 */
export type ChatTransportEvent =
  | { readonly type: "attached"; readonly snapshot: SessionRuntimeSnapshot }
  | { readonly type: "closed"; readonly reason: "session_closed" | "session_deleted" }
  | SessionScopedEvent;

export interface ChatSessionTransport {
  /**
   * Persistent subscription (call-to-dispose). Emits "attached" (subscription
   * open, snapshot fetched) and then the session's live events; on a server
   *-side drop it silently re-subscribes and emits "attached" again. Returns
   * the disposer.
   */
  subscribe(onEvent: (event: ChatTransportEvent) => void): () => void;
  /**
   * Submit a prompt: fire-and-forget at the wire level. The returned receipt
   * only acknowledges acceptance — the turn's content arrives through the
   * subscription like everyone else's. `messageId` is the optimistic user
   * message's id; the server echoes it on `session.prompt.submitted` (dedupe).
   */
  prompt(input: {
    readonly messageId: string;
    readonly parts: ReadonlyArray<PromptPart>;
  }): Promise<{ readonly turnId: string }>;
  steer(input: {
    readonly expectedTurnId: string;
    readonly messageId: string;
    readonly parts: ReadonlyArray<PromptPart>;
  }): Promise<void>;
  /**
   * The session's native history as final-form UIMessages, or `null` when this
   * harness serves no history — capability absence is a normal outcome here,
   * not an error. All three harnesses serve history today, so `null` is the
   * degraded path, not the common one.
   */
  getMessages(): Promise<readonly UIMessage[] | null>;
  /**
   * Resolves normally when the request is no longer pending — including when
   * another client answered it first (the server's "not pending" is an
   * outcome, not a failure, from the responder's point of view).
   */
  respondToAgentRequest(requestId: string, response: AgentResponse): Promise<void>;
  // Session-scoped config setters — separate session calls, never bundled into
  // a prompt turn. The transport already knows its SessionRef. The model is
  // the flat providerId/modelId pair — always together, modelId alone is only
  // unique within its provider.
  setModel(providerId: string, modelId: string): Promise<void>;
  setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

// Binds a SessionRef to a transport. ChatManager holds one of these instead of
// the wire client, so swapping the oRPC binding for anything else is a one-line
// change at the composition root.
export type ChatSessionTransportFactory = (sessionRef: SessionRef) => ChatSessionTransport;
