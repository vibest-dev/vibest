import type {
  CreateSessionInput,
  HarnessAgentId,
  PromptReceipt,
  ResumeSessionInput,
  SessionCapabilities,
  SessionEnvelopeDraft,
  UserInput,
  AgentResponse,
} from "@vibest/contract";
import type { Effect, Scope, Stream } from "effect";

import type {
  AgentOpenError,
  AgentOperationError,
  AgentRequestUnavailable,
  AgentUnavailable,
  CapabilityUnsupported,
  ExecutableNotFound,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "./errors";

export {
  CreateSessionInputSchema,
  InspectorTargetSchema,
  PromptReceiptSchema,
  ResumeSessionInputSchema,
  SessionCapabilitiesSchema,
  UserInputPartSchema,
  UserInputSchema,
  type CreateSessionInput,
  type InspectorTarget,
  type PromptReceipt,
  type ResumeSessionInput,
  type SessionCapabilities,
  type UserInput,
  type UserInputPart,
} from "@vibest/contract";

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

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly descriptor: AgentDescriptor;
  readonly checkAvailability: Effect.Effect<AvailabilityResult>;
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
