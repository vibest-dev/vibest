import { HarnessAgentIdSchema } from "@vibest/contract";
import { Schema } from "effect";

export { ClaudeSdkError } from "./claude-code/errors";

// A cause's one-line story, for error messages that would otherwise swallow
// it. These messages end up in daemon logs and RPC INTERNAL responses — a
// bare "failed to open" with the cause dropped is undiagnosable in the field.
const causeSummary = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
};

export class HarnessAgentNotFound extends Schema.TaggedError<HarnessAgentNotFound>()(
  "HarnessAgentNotFound",
  { harnessAgentId: HarnessAgentIdSchema },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' is not registered.`;
  }
}

export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()("AgentUnavailable", {
  harnessAgentId: HarnessAgentIdSchema,
  reason: Schema.String,
}) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' is unavailable: ${this.reason}`;
  }
}

export class ExecutableNotFound extends Schema.TaggedError<ExecutableNotFound>()(
  "ExecutableNotFound",
  {
    harnessAgentId: HarnessAgentIdSchema,
    executable: Schema.String,
  },
) {
  override get message() {
    return `Executable '${this.executable}' for '${this.harnessAgentId}' was not found.`;
  }
}

export class AgentOpenError extends Schema.TaggedError<AgentOpenError>()("AgentOpenError", {
  harnessAgentId: HarnessAgentIdSchema,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Failed to open a '${this.harnessAgentId}' session: ${causeSummary(this.cause)}`;
  }
}

/**
 * The native session is not open in this process. Named with the Harness
 * prefix (unlike its neighbours) because the session domain has its own
 * `SessionNotFound` — metadata missing from storage — and the two used to
 * share a tag, forcing structural sniffing at the RPC error mapping.
 */
export class HarnessSessionNotFound extends Schema.TaggedError<HarnessSessionNotFound>()(
  "HarnessSessionNotFound",
  {
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Session '${this.sessionId}' was not found.`;
  }
}

export class SessionNotResumable extends Schema.TaggedError<SessionNotResumable>()(
  "SessionNotResumable",
  {
    sessionId: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return this.reason
      ? `Session '${this.sessionId}' cannot be resumed: ${this.reason}`
      : `Session '${this.sessionId}' cannot be resumed.`;
  }
}

export class SessionClosed extends Schema.TaggedError<SessionClosed>()("SessionClosed", {
  sessionId: Schema.String,
}) {
  override get message() {
    return `Session '${this.sessionId}' is closed.`;
  }
}

export class RecoveryRequired extends Schema.TaggedError<RecoveryRequired>()("RecoveryRequired", {
  sessionId: Schema.String,
  recoveryId: Schema.String,
}) {
  override get message() {
    return `Session '${this.sessionId}' requires acknowledgement of recovery '${this.recoveryId}'.`;
  }
}

export class StaleRecovery extends Schema.TaggedError<StaleRecovery>()("StaleRecovery", {
  sessionId: Schema.String,
  recoveryId: Schema.String,
}) {
  override get message() {
    return `Recovery '${this.recoveryId}' is no longer pending for session '${this.sessionId}'.`;
  }
}

export class TurnAlreadyRunning extends Schema.TaggedError<TurnAlreadyRunning>()(
  "TurnAlreadyRunning",
  {
    sessionId: Schema.String,
    turnId: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return this.turnId
      ? `Turn '${this.turnId}' is already running in session '${this.sessionId}'.`
      : `A turn is already running in session '${this.sessionId}'.`;
  }
}

export class AgentRequestUnavailable extends Schema.TaggedError<AgentRequestUnavailable>()(
  "AgentRequestUnavailable",
  {
    sessionId: Schema.String,
    requestId: Schema.String,
  },
) {
  override get message() {
    return `Agent request '${this.requestId}' is unavailable in session '${this.sessionId}'.`;
  }
}

export class AgentOperationError extends Schema.TaggedError<AgentOperationError>()(
  "AgentOperationError",
  {
    sessionId: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Agent operation '${this.operation}' failed for session '${this.sessionId}': ${causeSummary(this.cause)}`;
  }
}

export class CodexTransportError extends Schema.TaggedError<CodexTransportError>()(
  "CodexTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Codex transport operation '${this.operation}' failed: ${causeSummary(this.cause)}`;
  }
}

export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  method: Schema.String,
  code: Schema.Number,
  errorMessage: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    return `Codex RPC '${this.method}' failed (${this.code}): ${this.errorMessage}`;
  }
}

export class PiTransportError extends Schema.TaggedError<PiTransportError>()("PiTransportError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Pi transport operation '${this.operation}' failed: ${causeSummary(this.cause)}`;
  }
}

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  command: Schema.String,
  errorMessage: Schema.String,
}) {
  override get message() {
    return `Pi RPC command '${this.command}' failed: ${this.errorMessage}`;
  }
}

export class GrokTransportError extends Schema.TaggedError<GrokTransportError>()(
  "GrokTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Grok transport operation '${this.operation}' failed: ${causeSummary(this.cause)}`;
  }
}

export class GrokRpcError extends Schema.TaggedError<GrokRpcError>()("GrokRpcError", {
  method: Schema.String,
  code: Schema.Number,
  errorMessage: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    return `Grok RPC '${this.method}' failed (${this.code}): ${this.errorMessage}`;
  }
}

export class AgentProcessExited extends Schema.TaggedError<AgentProcessExited>()(
  "AgentProcessExited",
  {
    harnessAgentId: HarnessAgentIdSchema,
    code: Schema.optionalKey(Schema.Number),
    signal: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    const detail = this.stderrTail ? ` ${this.stderrTail.trim()}` : "";
    if (this.code !== undefined) {
      return `The '${this.harnessAgentId}' process exited with code ${this.code}.${detail}`;
    }
    if (this.signal !== undefined) {
      return `The '${this.harnessAgentId}' process exited from signal ${this.signal}.${detail}`;
    }
    return `The '${this.harnessAgentId}' process exited.${detail}`;
  }
}

export class AgentProtocolError extends Schema.TaggedError<AgentProtocolError>()(
  "AgentProtocolError",
  {
    harnessAgentId: HarnessAgentIdSchema,
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `The '${this.harnessAgentId}' protocol failed: ${this.reason}`;
  }
}

// The requested permission mode is a member of vibest's vocabulary, but not of
// this harness's declared subset — a client bug by definition (the subset is
// closed and fully known to the client), so it maps to INVALID_ARGUMENT at the
// RPC boundary rather than being silently ignored or half-applied.
export class PermissionModeUnsupported extends Schema.TaggedError<PermissionModeUnsupported>()(
  "PermissionModeUnsupported",
  {
    harnessAgentId: HarnessAgentIdSchema,
    mode: Schema.String,
  },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' does not support permission mode '${this.mode}'.`;
  }
}

export class CapabilityProbeFailed extends Schema.TaggedError<CapabilityProbeFailed>()(
  "CapabilityProbeFailed",
  {
    harnessAgentId: HarnessAgentIdSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to probe '${this.harnessAgentId}' capabilities: ${causeSummary(this.cause)}`;
  }
}

export class CapabilityUnsupported extends Schema.TaggedError<CapabilityUnsupported>()(
  "CapabilityUnsupported",
  {
    harnessAgentId: HarnessAgentIdSchema,
    capability: Schema.String,
  },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' does not support '${this.capability}'.`;
  }
}

export type CreateSessionError =
  | HarnessAgentNotFound
  | AgentUnavailable
  | ExecutableNotFound
  | PermissionModeUnsupported
  | AgentOpenError;

export type ResumeSessionError =
  | HarnessAgentNotFound
  | HarnessSessionNotFound
  | SessionNotResumable
  | AgentUnavailable
  | ExecutableNotFound
  | AgentOpenError;
