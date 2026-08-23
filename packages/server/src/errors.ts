import { Data } from "effect";

/** Typed errors. All domain failures flow through the Effect error channel. */

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly projectId: string;
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

/** A prompt carried a part type this server cannot yet forward (e.g. `file`). */
export class UnsupportedPromptPart extends Data.TaggedError("UnsupportedPromptPart")<{
  readonly kind: string;
}> {}

/** A requested path resolves outside its `cwd` (via `..` or a symlink). */
export class WorkspacePathEscape extends Data.TaggedError("WorkspacePathEscape")<{
  readonly cwd: string;
  readonly path: string;
}> {}

/** The requested workspace path no longer exists. */
export class WorkspaceFileNotFound extends Data.TaggedError("WorkspaceFileNotFound")<{
  readonly path: string;
}> {}

/** The path exists but is not a regular file (e.g. a directory). */
export class WorkspaceNotFile extends Data.TaggedError("WorkspaceNotFile")<{
  readonly path: string;
}> {}

/** The path exists but is not a directory (e.g. a regular file). */
export class WorkspaceNotDirectory extends Data.TaggedError("WorkspaceNotDirectory")<{
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

export class PtyNotFound extends Data.TaggedError("PtyNotFound")<{
  readonly ptyId: string;
}> {}

export class PtyLimitReached extends Data.TaggedError("PtyLimitReached")<{
  readonly projectId: string;
  readonly limit: number;
}> {}

export class PtySpawnFailed extends Data.TaggedError("PtySpawnFailed")<{
  readonly projectId: string;
  readonly cause: unknown;
}> {}
