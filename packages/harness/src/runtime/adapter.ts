import type {
  AgentResponse,
  HarnessAgentId,
  InspectorTarget,
  SessionCapabilities,
} from "@vibest/contract";
import { InspectorTargetSchema, SessionCapabilitiesSchema } from "@vibest/contract";
import type { Effect, Scope, Stream } from "effect";

import type { SessionEnvelopeDraft } from "../events/framework";
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
  InspectorTargetSchema,
  PromptReceiptSchema,
  ResumeSessionInputSchema,
  SessionCapabilitiesSchema,
  UserInputPartSchema,
  UserInputSchema,
};
export type {
  CreateSessionInput,
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
}
