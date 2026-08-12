import type {
  AgentResponse,
  HarnessAgentId,
  InspectorTarget,
  PermissionMode,
  ModelInfo,
  ReasoningEffort,
  SessionCapabilities,
} from "@vibest/contract";
import { InspectorTargetSchema, SessionCapabilitiesSchema } from "@vibest/contract";
import type { UIMessage } from "ai";
import { Effect, type FileSystem, type Scope, type Stream } from "effect";

import { AgentOpenError } from "./errors";
import type {
  AgentOperationError,
  AgentRequestUnavailable,
  AgentUnavailable,
  CapabilityProbeFailed,
  CapabilityUnsupported,
  ExecutableNotFound,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "./errors";
import type { SessionEnvelopeDraft } from "./events/framework";
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

/**
 * One session's live execution resource: a pi RPC child, a Claude SDK
 * execution handle, a Codex thread on the shared app-server. It owns native
 * events, prompt, interrupt, request responses, the config knobs, and close —
 * and nothing else. A session's *observable* state (phase, active turn,
 * pending requests, seq/cursor, snapshots) belongs to the
 * `HarnessAgentSession` that optionally holds one of these, so a session
 * survives its runtime crashing, closing, or never having been started.
 */
export interface HarnessAgentRuntime {
  readonly sessionId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly events: Stream.Stream<SessionEnvelopeDraft, AgentOperationError>;
  readonly prompt: (
    input: UserInput,
  ) => Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>;
  readonly steer: (
    expectedTurnId: string,
    input: UserInput,
  ) => Effect.Effect<void, SessionClosed | TurnAlreadyRunning | AgentOperationError>;
  // Session-scoped config setters. `model` is the provider-local model id —
  // the server resolves and validates the providerId before it ever
  // reaches an adapter. Harnesses without a knob accept the call and no-op.
  readonly setModel: (model: string) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  readonly setReasoningEffort: (
    reasoningEffort: ReasoningEffort,
  ) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  // `mode` is vibest's own vocabulary; the adapter maps it to its native
  // system. A mode outside the adapter's declared subset is rejected at the
  // RPC boundary, so by the time it lands here it is a member the adapter
  // claimed to support.
  readonly setPermissionMode: (
    mode: PermissionMode,
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
  /**
   * The session's native transcript folded into final-form UIMessages —
   * everything up to and including the active turn; trimming the in-flight
   * tail is the facade's job. This is the *warm* read, the one that needs a
   * live runtime. Its presence alongside an absent {@link
   * HarnessAgentAdapter.getMessages} is what tells the facade that reading
   * this harness's history is itself a reason to acquire a runtime — pi is
   * that shape today.
   */
  readonly getMessages?: Effect.Effect<
    ReadonlyArray<UIMessage>,
    SessionClosed | AgentOperationError
  >;
  readonly close: Effect.Effect<void>;
}

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly descriptor: AgentDescriptor;
  /**
   * A PATH lookup, so it reads the filesystem — the requirement rides the `R`
   * channel out to whoever builds the service that calls it (list, session
   * service), which binds the platform layers at its own construction.
   */
  readonly checkAvailability: Effect.Effect<AvailabilityResult, never, FileSystem.FileSystem>;
  /**
   * The subset of vibest's permission vocabulary this harness can honour, and
   * which member to preselect. Plain values, not effects: they follow from the
   * adapter's own mapping table, so declaring them can never fail and never
   * costs a process. Empty means the harness has no permission protocol (pi).
   * The mapping to the native system (claude's `bypassPermissions`, codex's
   * approval policy + sandbox) is the adapter's private knowledge.
   */
  readonly permissionModes: ReadonlyArray<PermissionMode>;
  readonly defaultPermissionMode?: PermissionMode;
  /**
   * Probe this harness's built-in model provider in one working directory. It
   * follows the signed-in account, the installed version *and* the directory's
   * own config, so it can only be probed — never hardcoded, and never probed
   * once for everyone. Absent for harnesses with no model catalogue (pi).
   *
   * `cwd` is honoured where it matters: claude-code passes it to the SDK
   * because a project's settings can remap what a model id resolves to. Codex
   * ignores it — its `model/list` is app-server-global — but still takes it, so
   * callers never have to know which is which.
   *
   * The error channel is the point: a probe that fails has to stay
   * distinguishable from a harness that genuinely has no models, otherwise an
   * expired login gets cached as "this harness has no model picker".
   * {@link HarnessProbeService} owns the timeout, caching and de-duplication.
   */
  readonly probeModels?: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<ModelInfo>, CapabilityProbeFailed>;
  readonly open: (
    input: CreateSessionInput,
  ) => Effect.Effect<
    HarnessAgentRuntime,
    AgentUnavailable | ExecutableNotFound | AgentOpenError,
    Scope.Scope
  >;
  readonly resume: (
    input: ResumeSessionInput,
  ) => Effect.Effect<
    HarnessAgentRuntime,
    SessionNotResumable | AgentUnavailable | ExecutableNotFound | AgentOpenError,
    Scope.Scope
  >;
  /**
   * The *cold* history read: a persisted session's transcript as final-form
   * UIMessages, without opening it and without costing a process of its own.
   * claude-code parses the CLI's own transcript files; codex asks the shared
   * app-server. Absent means this harness has no diskless read — pi's
   * `get_entries` only answers from a live child — and the facade then falls
   * back to {@link HarnessAgentRuntime.getMessages}, acquiring a runtime if it
   * has to. Which of the two an adapter implements *is* its history policy;
   * there is no separate flag.
   */
  readonly getMessages?: (
    harnessSessionId: string,
    cwd?: string,
  ) => Effect.Effect<ReadonlyArray<UIMessage>, AgentOperationError>;
  /**
   * Look up live display info for a persisted session by backend id, without
   * opening it. `cwd` (the session's cwd) narrows the backend search.
   */
  readonly getSessionInfo: (
    harnessSessionId: string,
    cwd?: string,
  ) => Effect.Effect<SessionInfoResult, AgentOperationError>;
}
