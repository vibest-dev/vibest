import { Schema } from "effect";

// Workspace read failures: everything the confined file reader can refuse.
// Each carries the offending path — the RPC layer forwards them as typed
// protocol errors with structured data, so fields must stay wire-safe.

/** A requested path resolves outside its `cwd` (via `..` or a symlink). */
export class WorkspacePathEscape extends Schema.TaggedErrorClass<WorkspacePathEscape>()(
  "Workspace.PathEscape",
  {
    cwd: Schema.String,
    path: Schema.String,
  },
) {
  override get message() {
    return `Path '${this.path}' escapes workspace '${this.cwd}'.`;
  }
}

/** The path exists but is not a regular file (e.g. a directory). */
export class WorkspaceNotFile extends Schema.TaggedErrorClass<WorkspaceNotFile>()(
  "Workspace.NotFile",
  {
    path: Schema.String,
  },
) {
  override get message() {
    return `'${this.path}' is not a regular file.`;
  }
}

/** The file is larger than the read limit; rejected rather than truncated. */
export class WorkspaceFileTooLarge extends Schema.TaggedErrorClass<WorkspaceFileTooLarge>()(
  "Workspace.FileTooLarge",
  {
    path: Schema.String,
    size: Schema.Number,
    limit: Schema.Number,
  },
) {
  override get message() {
    return `'${this.path}' is ${this.size} bytes, over the ${this.limit}-byte read limit.`;
  }
}

/** The file contains a NUL byte, so we treat it as binary and refuse to read it as text. */
export class WorkspaceBinaryFile extends Schema.TaggedErrorClass<WorkspaceBinaryFile>()(
  "Workspace.BinaryFile",
  {
    path: Schema.String,
  },
) {
  override get message() {
    return `'${this.path}' looks binary and cannot be read as text.`;
  }
}

/** An underlying `FileSystem` read failed (missing, permission, etc.). */
export class WorkspaceReadError extends Schema.TaggedErrorClass<WorkspaceReadError>()(
  "Workspace.ReadError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to read '${this.path}'.`;
  }
}
