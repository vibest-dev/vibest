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

export class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly cause: unknown;
}> {}

export class InvalidSessionId extends Data.TaggedError("InvalidSessionId")<{
  readonly sessionId: string;
}> {}
