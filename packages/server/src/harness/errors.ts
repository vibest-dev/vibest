import { HarnessAgentIdSchema } from "@vibest/contract";
import { Schema } from "effect";

// A cause's one-line story, for error messages that would otherwise swallow
// it. These messages end up in daemon logs — a bare "failed to open" with the
// cause dropped is undiagnosable in the field.
export const causeSummary = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
};

// ---------------------------------------------------------------------------
// Session addressing — our own records. Tags are namespaced `Session.*`; the
// harness's view of a native session lives under `Harness.*` below, so the
// two "not found" meanings can never be confused again.
// ---------------------------------------------------------------------------

/** The session metadata record is missing from storage. */
export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()(
  "Session.NotFound",
  {
    projectId: Schema.String,
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Session '${this.sessionId}' not found in project '${this.projectId}'.`;
  }
}

/** A SessionRef's harnessAgentId disagrees with the stored session metadata. */
export class SessionRefMismatch extends Schema.TaggedErrorClass<SessionRefMismatch>()(
  "Session.RefMismatch",
  {
    projectId: Schema.String,
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Ref mismatch for session '${this.sessionId}' in project '${this.projectId}'.`;
  }
}

/** No stored session matches a bare sessionId during reverse lookup. */
export class SessionRefNotFound extends Schema.TaggedErrorClass<SessionRefNotFound>()(
  "Session.RefNotFound",
  {
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `No stored session matches '${this.sessionId}'.`;
  }
}

/** A prompt carried a part type this server cannot yet forward (e.g. `file`). */
export class UnsupportedPromptPart extends Schema.TaggedErrorClass<UnsupportedPromptPart>()(
  "Session.UnsupportedPromptPart",
  {
    kind: Schema.String,
  },
) {
  override get message() {
    return `Prompt part kind '${this.kind}' is not supported.`;
  }
}

// ---------------------------------------------------------------------------
// The harness domain: adapters, native sessions, capabilities.
// ---------------------------------------------------------------------------

export class HarnessAgentNotFound extends Schema.TaggedErrorClass<HarnessAgentNotFound>()(
  "Harness.AgentNotFound",
  { harnessAgentId: HarnessAgentIdSchema },
) {
  override get message() {
    return `Harness agent '${this.harnessAgentId}' is not registered.`;
  }
}

export class AgentUnavailable extends Schema.TaggedErrorClass<AgentUnavailable>()(
  "Harness.AgentUnavailable",
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
  "Harness.ExecutableNotFound",
  {
    harnessAgentId: HarnessAgentIdSchema,
    executable: Schema.String,
  },
) {
  override get message() {
    return `Executable '${this.executable}' for '${this.harnessAgentId}' was not found.`;
  }
}

export class AgentOpenError extends Schema.TaggedErrorClass<AgentOpenError>()(
  "Harness.AgentOpenError",
  {
    harnessAgentId: HarnessAgentIdSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to open a '${this.harnessAgentId}' session: ${causeSummary(this.cause)}`;
  }
}

/** The native session is not open in this process (cf. `Session.NotFound`, which is about our own records). */
export class HarnessSessionNotFound extends Schema.TaggedErrorClass<HarnessSessionNotFound>()(
  "Harness.SessionNotFound",
  {
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Session '${this.sessionId}' was not found.`;
  }
}

export class SessionNotResumable extends Schema.TaggedErrorClass<SessionNotResumable>()(
  "Harness.SessionNotResumable",
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

export class SessionClosed extends Schema.TaggedErrorClass<SessionClosed>()(
  "Harness.SessionClosed",
  {
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Session '${this.sessionId}' is closed.`;
  }
}

export class TurnAlreadyRunning extends Schema.TaggedErrorClass<TurnAlreadyRunning>()(
  "Harness.TurnAlreadyRunning",
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
  "Harness.AgentRequestUnavailable",
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
  "Harness.AgentOperationError",
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

export class AgentProcessExited extends Schema.TaggedErrorClass<AgentProcessExited>()(
  "Harness.AgentProcessExited",
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
  "Harness.AgentProtocolError",
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
  "Harness.PermissionModeUnsupported",
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
  "Harness.CapabilityProbeFailed",
  {
    harnessAgentId: HarnessAgentIdSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to probe '${this.harnessAgentId}' capabilities: ${causeSummary(this.cause)}`;
  }
}

export class CapabilityUnsupported extends Schema.TaggedErrorClass<CapabilityUnsupported>()(
  "Harness.CapabilityUnsupported",
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
