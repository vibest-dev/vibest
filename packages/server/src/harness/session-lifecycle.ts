import type { SessionEvent } from "@vibest/harness";
import type { TokenUsage, TurnError } from "@vibest/harness";
import type { AgentRequest, AgentResponse } from "@vibest/harness";
import { HashMap } from "effect";

import { AgentRequestUnavailable, LifecycleViolation, SessionClosed } from "./errors";

export type LifecyclePhase = "open" | "closing" | "closed" | "crashed";

export type PendingRequestState = {
  readonly request: AgentRequest;
};

export type LifecycleState = {
  readonly sessionId: string;
  readonly phase: LifecyclePhase;
  readonly activeTurnId: string | undefined;
  readonly pendingRequests: HashMap.HashMap<string, PendingRequestState>;
};

export type PendingRequestAction =
  | {
      readonly type: "reply";
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | {
      readonly type: "reject";
      readonly requestId: string;
      readonly reason?: string;
    };

export type LifecycleCommand =
  | { readonly type: "turn.start"; readonly turnId: string }
  | {
      readonly type: "turn.end";
      readonly turnId: string;
      readonly outcome: "completed" | "failed" | "canceled";
      readonly usage?: TokenUsage;
      readonly error?: TurnError;
    }
  | { readonly type: "request.ask"; readonly request: AgentRequest }
  | {
      readonly type: "request.reply";
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | { readonly type: "request.reject"; readonly requestId: string; readonly reason?: string }
  | { readonly type: "session.close" }
  | { readonly type: "session.closed" }
  | { readonly type: "session.crash"; readonly reason: string };

export type LifecycleTransition =
  | {
      readonly ok: true;
      readonly state: LifecycleState;
      readonly events: ReadonlyArray<SessionEvent>;
      readonly actions: ReadonlyArray<PendingRequestAction>;
    }
  | {
      readonly ok: false;
      readonly error: LifecycleViolation | AgentRequestUnavailable | SessionClosed;
    };

export const initialLifecycleState = (sessionId: string): LifecycleState => ({
  sessionId,
  phase: "open",
  activeTurnId: undefined,
  pendingRequests: HashMap.empty(),
});

const success = (
  state: LifecycleState,
  events: ReadonlyArray<SessionEvent> = [],
  actions: ReadonlyArray<PendingRequestAction> = [],
): LifecycleTransition => ({ ok: true, state, events, actions });

const violation = (state: LifecycleState, transition: string): LifecycleTransition => ({
  ok: false,
  error: new LifecycleViolation({
    sessionId: state.sessionId,
    state: state.phase,
    transition,
  }),
});

const ensureOpen = (state: LifecycleState): LifecycleTransition | undefined =>
  state.phase === "open"
    ? undefined
    : {
        ok: false,
        error: new SessionClosed({ sessionId: state.sessionId }),
      };

const rejectPendingRequests = (
  state: LifecycleState,
  reason: string,
): {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly actions: ReadonlyArray<PendingRequestAction>;
} => {
  const pending = Array.from(HashMap.values(state.pendingRequests));
  return {
    events: pending.map(({ request }) => ({
      type: "session.request.rejected" as const,
      sessionId: state.sessionId,
      requestId: request.id,
      reason,
    })),
    actions: pending.map(({ request }) => ({
      type: "reject" as const,
      requestId: request.id,
      reason,
    })),
  };
};

export const reduceLifecycle = (
  state: LifecycleState,
  command: LifecycleCommand,
): LifecycleTransition => {
  switch (command.type) {
    case "turn.start": {
      const closed = ensureOpen(state);
      if (closed) return closed;
      if (state.activeTurnId !== undefined) return violation(state, command.type);
      return success({ ...state, activeTurnId: command.turnId }, [
        {
          type: "session.turn.started",
          sessionId: state.sessionId,
          turnId: command.turnId,
        },
      ]);
    }

    case "turn.end": {
      if (state.activeTurnId !== command.turnId) return violation(state, command.type);
      return success({ ...state, activeTurnId: undefined }, [
        {
          type: "session.turn.ended",
          sessionId: state.sessionId,
          turnId: command.turnId,
          outcome: command.outcome,
          ...(command.usage ? { usage: command.usage } : {}),
          ...(command.error ? { error: command.error } : {}),
        },
      ]);
    }

    case "request.ask": {
      const closed = ensureOpen(state);
      if (closed) return closed;
      if (HashMap.has(state.pendingRequests, command.request.id)) {
        return violation(state, command.type);
      }
      return success(
        {
          ...state,
          pendingRequests: HashMap.set(state.pendingRequests, command.request.id, {
            request: command.request,
          }),
        },
        [
          {
            type: "session.request.asked",
            sessionId: state.sessionId,
            request: command.request,
          },
        ],
      );
    }

    case "request.reply": {
      if (!HashMap.has(state.pendingRequests, command.requestId)) {
        return {
          ok: false,
          error: new AgentRequestUnavailable({
            sessionId: state.sessionId,
            requestId: command.requestId,
          }),
        };
      }
      return success(
        {
          ...state,
          pendingRequests: HashMap.remove(state.pendingRequests, command.requestId),
        },
        [
          {
            type: "session.request.replied",
            sessionId: state.sessionId,
            requestId: command.requestId,
          },
        ],
        [{ type: "reply", requestId: command.requestId, response: command.response }],
      );
    }

    case "request.reject": {
      if (!HashMap.has(state.pendingRequests, command.requestId)) {
        return {
          ok: false,
          error: new AgentRequestUnavailable({
            sessionId: state.sessionId,
            requestId: command.requestId,
          }),
        };
      }
      return success(
        {
          ...state,
          pendingRequests: HashMap.remove(state.pendingRequests, command.requestId),
        },
        [
          {
            type: "session.request.rejected",
            sessionId: state.sessionId,
            requestId: command.requestId,
            ...(command.reason ? { reason: command.reason } : {}),
          },
        ],
        [
          {
            type: "reject",
            requestId: command.requestId,
            ...(command.reason ? { reason: command.reason } : {}),
          },
        ],
      );
    }

    case "session.close": {
      if (state.phase === "closed" || state.phase === "closing") return success(state);
      if (state.phase === "crashed") return success(state);
      const rejected = rejectPendingRequests(state, "Session closed");
      const turnEvents: ReadonlyArray<SessionEvent> = state.activeTurnId
        ? [
            {
              type: "session.turn.ended",
              sessionId: state.sessionId,
              turnId: state.activeTurnId,
              outcome: "canceled",
            },
          ]
        : [];
      return success(
        {
          ...state,
          phase: "closing",
          activeTurnId: undefined,
          pendingRequests: HashMap.empty(),
        },
        [...turnEvents, ...rejected.events],
        rejected.actions,
      );
    }

    case "session.closed": {
      if (state.phase === "closed") return success(state);
      if (state.phase !== "closing") return violation(state, command.type);
      return success({ ...state, phase: "closed" });
    }

    case "session.crash": {
      if (state.phase === "closed" || state.phase === "crashed") {
        return violation(state, command.type);
      }
      const rejected = rejectPendingRequests(state, command.reason);
      const turnEvents: ReadonlyArray<SessionEvent> = state.activeTurnId
        ? [
            {
              type: "session.turn.ended",
              sessionId: state.sessionId,
              turnId: state.activeTurnId,
              outcome: "failed",
              error: { message: command.reason, category: "unknown" },
            },
          ]
        : [];
      return success(
        {
          ...state,
          phase: "crashed",
          activeTurnId: undefined,
          pendingRequests: HashMap.empty(),
        },
        [
          {
            type: "session.crashed",
            sessionId: state.sessionId,
            reason: command.reason,
          },
          ...rejected.events,
          ...turnEvents,
        ],
        rejected.actions,
      );
    }
  }
};
