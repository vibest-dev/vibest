import { HarnessAgentIdSchema } from "@vibest/harness";
import { Schema } from "effect";

export { ClaudeSdkError } from "@vibest/harness/claude-code";

export class HarnessAgentNotFound extends Schema.TaggedErrorClass<HarnessAgentNotFound>()(
  "HarnessAgentNotFound",
  { harnessAgentId: HarnessAgentIdSchema },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' is not registered.`;
  }
}

export class AgentUnavailable extends Schema.TaggedErrorClass<AgentUnavailable>()(
  "AgentUnavailable",
  {
    harnessAgentId: HarnessAgentIdSchema,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' is unavailable: ${this.reason}`;
  }
}

export class ExecutableNotFound extends Schema.TaggedErrorClass<ExecutableNotFound>()(
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

export class AgentOpenError extends Schema.TaggedErrorClass<AgentOpenError>()("AgentOpenError", {
  harnessAgentId: HarnessAgentIdSchema,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Failed to open a '${this.harnessAgentId}' session.`;
  }
}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String,
}) {
  override get message() {
    return `Session '${this.sessionId}' was not found.`;
  }
}

export class SessionNotResumable extends Schema.TaggedErrorClass<SessionNotResumable>()(
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

export class SessionClosed extends Schema.TaggedErrorClass<SessionClosed>()("SessionClosed", {
  sessionId: Schema.String,
}) {
  override get message() {
    return `Session '${this.sessionId}' is closed.`;
  }
}

export class TurnAlreadyRunning extends Schema.TaggedErrorClass<TurnAlreadyRunning>()(
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

export class AgentRequestUnavailable extends Schema.TaggedErrorClass<AgentRequestUnavailable>()(
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

export class AgentOperationError extends Schema.TaggedErrorClass<AgentOperationError>()(
  "AgentOperationError",
  {
    sessionId: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Agent operation '${this.operation}' failed for session '${this.sessionId}'.`;
  }
}

export class CodexTransportError extends Schema.TaggedErrorClass<CodexTransportError>()(
  "CodexTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Codex transport operation '${this.operation}' failed.`;
  }
}

export class CodexRpcError extends Schema.TaggedErrorClass<CodexRpcError>()("CodexRpcError", {
  method: Schema.String,
  code: Schema.Number,
  errorMessage: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    return `Codex RPC '${this.method}' failed (${this.code}): ${this.errorMessage}`;
  }
}

export class PiTransportError extends Schema.TaggedErrorClass<PiTransportError>()(
  "PiTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Pi transport operation '${this.operation}' failed.`;
  }
}

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  command: Schema.String,
  errorMessage: Schema.String,
}) {
  override get message() {
    return `Pi RPC command '${this.command}' failed: ${this.errorMessage}`;
  }
}

export class AgentProcessExited extends Schema.TaggedErrorClass<AgentProcessExited>()(
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

export class AgentProtocolError extends Schema.TaggedErrorClass<AgentProtocolError>()(
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
export class PermissionModeUnsupported extends Schema.TaggedErrorClass<PermissionModeUnsupported>()(
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

export class CapabilityProbeFailed extends Schema.TaggedErrorClass<CapabilityProbeFailed>()(
  "CapabilityProbeFailed",
  {
    harnessAgentId: HarnessAgentIdSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to probe '${this.harnessAgentId}' capabilities.`;
  }
}

export class CapabilityUnsupported extends Schema.TaggedErrorClass<CapabilityUnsupported>()(
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
  | SessionNotFound
  | SessionNotResumable
  | AgentUnavailable
  | ExecutableNotFound
  | AgentOpenError;
