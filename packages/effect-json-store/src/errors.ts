import { Data } from "effect";

/** Reading the file failed for a reason other than it not existing. */
export class JsonStoreReadError extends Data.TaggedError("JsonStoreReadError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/** Creating the parent directory, writing the temp file, or renaming it failed. */
export class JsonStoreWriteError extends Data.TaggedError("JsonStoreWriteError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/** The file exists but is not valid JSON. Never auto-reset; the caller decides. */
export class JsonStoreParseError extends Data.TaggedError("JsonStoreParseError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/** The JSON is valid but not a `{ version, data }` envelope with a positive integer version. */
export class JsonStoreFormatError extends Data.TaggedError("JsonStoreFormatError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/**
 * The file was written by a newer version chain than this code knows.
 * Typical cause: the app was downgraded after an upgrade wrote the file.
 * The store never touches the file in this state.
 */
export class JsonStoreVersionTooNewError extends Data.TaggedError("JsonStoreVersionTooNewError")<{
  readonly file: string;
  readonly fileVersion: number;
  readonly latestVersion: number;
}> {}

/** The data does not satisfy the schema of the version the file declares. */
export class JsonStoreDecodeError extends Data.TaggedError("JsonStoreDecodeError")<{
  readonly file: string;
  readonly version: number;
  readonly cause: unknown;
}> {}

/** Encoding a value with the latest schema failed before writing to disk. */
export class JsonStoreEncodeError extends Data.TaggedError("JsonStoreEncodeError")<{
  readonly file: string;
  readonly cause: unknown;
}> {}

/** A `migrate()` step threw, or produced a value that fails the next version's schema. */
export class JsonStoreMigrationError extends Data.TaggedError("JsonStoreMigrationError")<{
  readonly file: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly cause: unknown;
}> {}

/** Everything `make`/`load` can fail with. */
export type JsonStoreLoadError =
  | JsonStoreReadError
  | JsonStoreParseError
  | JsonStoreFormatError
  | JsonStoreVersionTooNewError
  | JsonStoreDecodeError
  | JsonStoreMigrationError
  | JsonStoreEncodeError
  | JsonStoreWriteError;

export type JsonStoreError = JsonStoreLoadError;
