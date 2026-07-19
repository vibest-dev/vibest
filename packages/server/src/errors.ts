import { Data } from "effect";

/** Typed errors. All domain failures flow through the Effect error channel. */

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly projectId: string;
}> {}

export class McpServerNotFound extends Data.TaggedError("McpServerNotFound")<{
  readonly serverId: string;
}> {}

export class StoreReadError extends Data.TaggedError("StoreReadError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

export class StoreWriteError extends Data.TaggedError("StoreWriteError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly cause: unknown;
}> {}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly projectId: string;
  readonly sessionId: string;
}> {}

/** A SessionRef's harnessAgentId disagrees with the stored session metadata. */
export class SessionRefMismatch extends Data.TaggedError("SessionRefMismatch")<{
  readonly projectId: string;
  readonly sessionId: string;
}> {}

/** No stored session matches a bare sessionId during reverse lookup. */
export class SessionRefNotFound extends Data.TaggedError("SessionRefNotFound")<{
  readonly sessionId: string;
}> {}

/** The requested harness agent backend is not available to open/resume. */
export class AgentUnavailable extends Data.TaggedError("AgentUnavailable")<{
  readonly harnessAgentId: string;
  readonly reason: string;
}> {}

/** The harness failed to open a fresh native session. */
export class SessionOpenFailed extends Data.TaggedError("SessionOpenFailed")<{
  readonly harnessAgentId: string;
  readonly reason: string;
}> {}

/** The harness failed to resume a native session from its stored id. */
export class SessionResumeFailed extends Data.TaggedError("SessionResumeFailed")<{
  readonly harnessSessionId: string;
  readonly reason: string;
}> {}

/** A prompt carried a part type this server cannot yet forward (e.g. `file`). */
export class UnsupportedPromptPart extends Data.TaggedError("UnsupportedPromptPart")<{
  readonly kind: string;
}> {}

/** A requested path resolves outside its `cwd` (via `..` or a symlink). */
export class WorkspacePathEscape extends Data.TaggedError("WorkspacePathEscape")<{
  readonly cwd: string;
  readonly path: string;
}> {}

/** The path exists but is not a regular file (e.g. a directory). */
export class WorkspaceNotFile extends Data.TaggedError("WorkspaceNotFile")<{
  readonly path: string;
}> {}

/** The file is larger than the read limit; rejected rather than truncated. */
export class WorkspaceFileTooLarge extends Data.TaggedError("WorkspaceFileTooLarge")<{
  readonly path: string;
  readonly size: number;
  readonly limit: number;
}> {}

/** The file contains a NUL byte, so we treat it as binary and refuse to read it as text. */
export class WorkspaceBinaryFile extends Data.TaggedError("WorkspaceBinaryFile")<{
  readonly path: string;
}> {}

/** An underlying `FileSystem` read failed (missing, permission, etc.). */
export class WorkspaceReadError extends Data.TaggedError("WorkspaceReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}
