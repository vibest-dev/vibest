import { Crypto, Effect, FileSystem, Path, type PlatformError } from "effect";

import { StoreReadError, StoreWriteError } from "../errors";

/**
 * The platform services the JSON store runs on. Repositories bind them once at
 * layer construction so their own methods stay `R`-free; the requirement rides
 * the Layer's `R` up to the composition root, which provides the Node layers.
 */
export type JsonStorePlatform = FileSystem.FileSystem | Path.Path | Crypto.Crypto;

/**
 * "The file isn't there" in platform terms: the Node `FileSystem` normalises
 * `ENOENT` to a `NotFound` reason, so callers test that instead of an errno.
 */
export const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

/**
 * Read a JSON file, returning `fallback` if it does not exist yet.
 * A malformed or unreadable existing file fails with `StoreReadError`.
 */
export const readJson = <A>(
  file: string,
  fallback: A,
): Effect.Effect<A, StoreReadError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(file)
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (raw === undefined) return fallback;
    return yield* Effect.try(() => JSON.parse(raw) as A);
  }).pipe(Effect.mapError((cause) => new StoreReadError({ file, cause })));

/**
 * Write JSON via "temp file + atomic rename" so a crash mid-write can never
 * leave a half-written / corrupt file. Creates parent dirs as needed.
 */
export const writeJsonAtomic = (
  file: string,
  data: unknown,
): Effect.Effect<void, StoreWriteError, JsonStorePlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const body = yield* Effect.try(() => `${JSON.stringify(data, null, 2)}\n`);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const id = yield* crypto.randomUUIDv4;
    const tmp = `${file}.${id}.tmp`;
    yield* fs.writeFileString(tmp, body);
    yield* fs.rename(tmp, file);
  }).pipe(Effect.mapError((cause) => new StoreWriteError({ file, cause })));

/**
 * Read every `*.json` file in a directory, parsed as `A`. A missing directory
 * yields `[]` (the collection just hasn't been written to yet). A malformed
 * file fails the whole read with `StoreReadError`.
 */
export const readJsonDir = <A>(
  dir: string,
): Effect.Effect<ReadonlyArray<A>, StoreReadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed<Array<string>>([])));
    return yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")),
      (name) =>
        fs
          .readFileString(path.join(dir, name))
          .pipe(Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as A))),
    );
  }).pipe(Effect.mapError((cause) => new StoreReadError({ file: dir, cause })));

/** Delete a file. A file that is already gone is not an error. */
export const removeFile = (
  file: string,
): Effect.Effect<void, StoreWriteError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file, { force: true });
  }).pipe(Effect.mapError((cause) => new StoreWriteError({ file, cause })));
