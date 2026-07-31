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
import { Effect, type Scope, type Stream } from "effect";

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

export interface HarnessAgentSession {
  readonly sessionId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly events: Stream.Stream<SessionEnvelopeDraft, AgentOperationError>;
  readonly prompt: (
    input: UserInput,
  ) => Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>;
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
  readonly close: Effect.Effect<void>;
}

// Seed a freshly opened session with the config chosen at create time, using
// the same session setters the UI drives mid-session. Runs before the first
// prompt, so the config is live by the opening turn.
//
// The two channels fail differently on purpose (harness-concept-ownership §3.3):
// `permissionMode` was validated at the RPC boundary, so failing to apply it is
// a real fault and the open fails with it. `model`/`reasoningEffort` come from probed
// lists that go stale (an old URL, a re-mapped alias), so they are best-effort:
// a miss is logged and the session opens on the harness default rather than
// turning "the list was a bit old" into "the session cannot be created".
export const applyInitialSessionConfig = (
  session: HarnessAgentSession,
  input: CreateSessionInput,
): Effect.Effect<void, AgentOpenError> =>
  Effect.gen(function* () {
    if (input.permissionMode) {
      yield* session
        .setPermissionMode(input.permissionMode)
        .pipe(
          Effect.mapError(
            (cause) => new AgentOpenError({ harnessAgentId: session.harnessAgentId, cause }),
          ),
        );
    }
    if (input.model) {
      yield* session
        .setModel(input.model)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("create-time model apply failed; using the harness default", cause),
          ),
        );
    }
    if (input.reasoningEffort) {
      yield* session
        .setReasoningEffort(input.reasoningEffort)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "create-time reasoningEffort apply failed; using the model default",
              cause,
            ),
          ),
        );
    }
  });

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly descriptor: AgentDescriptor;
  readonly checkAvailability: Effect.Effect<AvailabilityResult>;
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
   * opening it. `cwd` (the session's cwd) narrows the backend search.
   */
  readonly getSessionInfo: (
    harnessSessionId: string,
    cwd?: string,
  ) => Effect.Effect<SessionInfoResult, AgentOperationError>;
}
