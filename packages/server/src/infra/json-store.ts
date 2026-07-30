import path from "node:path";

import { Crypto, Effect, FileSystem, type PlatformError } from "effect";

import { StoreReadError, StoreWriteError } from "../errors";

/**
 * The platform services the JSON store runs on. Callers bind them once at layer
 * construction so their own methods stay `R`-free; the requirement rides the
 * Layer's `R` up to the composition root, which provides the Node layers.
 */
export type JsonStorePlatform = FileSystem.FileSystem | Crypto.Crypto;

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
    const crypto = yield* Crypto.Crypto;

    const body = yield* Effect.try(() => `${JSON.stringify(data, null, 2)}\n`);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const id = yield* crypto.randomUUIDv4;
    const tmp = `${file}.${id}.tmp`;
    yield* fs.writeFileString(tmp, body);
    yield* fs.rename(tmp, file);
  }).pipe(Effect.mapError((cause) => new StoreWriteError({ file, cause })));

/**
 * The store with the platform bound once. Repositories yield this while their
 * Layer is being built, so their own methods stay `R`-free and the requirement
 * rides the Layer's `R` up to the composition root.
 */
export const boundJsonStore: Effect.Effect<
  {
    readonly read: <A>(file: string, fallback: A) => Effect.Effect<A, StoreReadError>;
    readonly write: (file: string, data: unknown) => Effect.Effect<void, StoreWriteError>;
  },
  never,
  JsonStorePlatform
> = Effect.gen(function* () {
  const platform = yield* Effect.context<JsonStorePlatform>();
  return {
    read: (file, fallback) => readJson(file, fallback).pipe(Effect.provide(platform)),
    write: (file, data) => writeJsonAtomic(file, data).pipe(Effect.provide(platform)),
  };
});
