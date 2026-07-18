import type {
  CreateSessionInput,
  HarnessAgentCapabilities,
  HarnessAgentId,
  PromptReceipt,
  ResumeSessionInput,
  SessionCapabilities,
  SessionEnvelopeDraft,
  UserInput,
  AgentResponse,
} from "@vibest/contract";
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

export {
  CreateSessionInputSchema,
  HarnessAgentCapabilitiesSchema,
  InspectorTargetSchema,
  PromptReceiptSchema,
  ResumeSessionInputSchema,
  SessionCapabilitiesSchema,
  UserInputPartSchema,
  UserInputSchema,
  type CreateSessionInput,
  type HarnessAgentCapabilities,
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
}
