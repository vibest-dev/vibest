import type {
  AgentResponse,
  HarnessAgentCapabilities,
  HarnessAgentId,
  InspectorTarget,
  SessionCapabilities,
} from "@vibest/contract";
import {
  HarnessAgentCapabilitiesSchema,
  InspectorTargetSchema,
  SessionCapabilitiesSchema,
} from "@vibest/contract";
import type { SessionEnvelopeDraft } from "@vibest/harness";
import { Effect, type Scope, type Stream } from "effect";

import { AgentOpenError } from "./errors";
import type {
  AgentOperationError,
  AgentRequestUnavailable,
  AgentUnavailable,
  CapabilityUnsupported,
  ExecutableNotFound,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "./errors";
import {
  CreateSessionInputSchema,
  PromptReceiptSchema,
  ResumeSessionInputSchema,
  UserInputPartSchema,
  UserInputSchema,
  type CreateSessionInput,
  type PromptReceipt,
  type ResumeSessionInput,
  type UserInput,
  type UserInputPart,
} from "./session-io";

export {
  CreateSessionInputSchema,
  HarnessAgentCapabilitiesSchema,
  InspectorTargetSchema,
  PromptReceiptSchema,
  ResumeSessionInputSchema,
  SessionCapabilitiesSchema,
  UserInputPartSchema,
  UserInputSchema,
};
export type {
  CreateSessionInput,
  HarnessAgentCapabilities,
  InspectorTarget,
  PromptReceipt,
  ResumeSessionInput,
  SessionCapabilities,
  UserInput,
  UserInputPart,
};

export type AgentDescriptor = {
  readonly id: HarnessAgentId;
  readonly name: string;
};

export type AvailabilityResult = {
  readonly available: boolean;
  readonly reason?: string;
};

/** Live display data for a session, fetched from the backend at list time. */
export type HarnessSessionInfo = {
  readonly title?: string;
  readonly updatedAt?: number;
};

/**
 * Result of looking up a persisted session's backend info:
 * - `found`       — backend still has it; `info` carries display fields
 * - `missing`     — backend transcript is gone (deleted); not resumable
 * - `unsupported` — this adapter can't query session info (treat as unknown)
 */
export type SessionInfoResult =
  | { readonly _tag: "found"; readonly info: HarnessSessionInfo }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unsupported" };

export interface HarnessAgentSession {
  readonly sessionId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly events: Stream.Stream<SessionEnvelopeDraft, AgentOperationError>;
  readonly prompt: (
    input: UserInput,
  ) => Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>;
  // Session-scoped config setters. Harnesses that don't support a knob accept
  // the call and no-op (e.g. Codex has no runtime model switch).
  readonly setModel: (model: string) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  // `mode` is an outward permission-mode id from this harness's capabilities.
  readonly setPermissionMode: (
    mode: string,
  ) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  readonly interrupt: Effect.Effect<void, SessionClosed | AgentOperationError>;
  readonly respondToAgentRequest: (
    requestId: string,
    response: AgentResponse,
  ) => Effect.Effect<void, AgentRequestUnavailable | AgentOperationError>;
  readonly getCapabilities: Effect.Effect<
    SessionCapabilities,
    CapabilityUnsupported | AgentOperationError
  >;
  readonly close: Effect.Effect<void>;
}

// Seed a freshly opened session with the model / permission mode chosen at
// create time, using the same session setters the UI drives mid-session. Runs
// before the first prompt, so the config is live by the opening turn.
export const applyInitialSessionConfig = (
  session: HarnessAgentSession,
  input: CreateSessionInput,
): Effect.Effect<void, AgentOpenError> =>
  Effect.all(
    [
      input.model ? session.setModel(input.model) : Effect.void,
      input.permissionMode ? session.setPermissionMode(input.permissionMode) : Effect.void,
    ],
    { discard: true },
  ).pipe(
    Effect.mapError(
      (cause) => new AgentOpenError({ harnessAgentId: session.harnessAgentId, cause }),
    ),
  );

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly descriptor: AgentDescriptor;
  readonly checkAvailability: Effect.Effect<AvailabilityResult>;
  // Negotiated once when the adapter is constructed; shared by all its sessions.
  readonly capabilities: Effect.Effect<HarnessAgentCapabilities>;
  readonly open: (
    input: CreateSessionInput,
  ) => Effect.Effect<
    HarnessAgentSession,
    AgentUnavailable | ExecutableNotFound | AgentOpenError,
    Scope.Scope
  >;
  readonly resume: (
    input: ResumeSessionInput,
  ) => Effect.Effect<
    HarnessAgentSession,
    SessionNotResumable | AgentUnavailable | ExecutableNotFound | AgentOpenError,
    Scope.Scope
  >;
  /**
   * Look up live display info for a persisted session by backend id, without
   * opening it. `workspacePath` (the session's cwd) narrows the backend search.
   */
  readonly getSessionInfo: (
    harnessSessionId: string,
    workspacePath?: string,
  ) => Effect.Effect<SessionInfoResult, AgentOperationError>;
}
