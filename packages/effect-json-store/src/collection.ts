import path from "node:path";

import { Effect, FileSystem, Option } from "effect";

import { type AnySchema, makeFileCodec, type MigrationStep } from "./codec";
import {
  type JsonStoreEncodeError,
  type JsonStoreLoadError,
  JsonStoreReadError,
  JsonStoreWriteError,
} from "./errors";

export interface JsonCollectionEntry<A> {
  readonly id: string;
  readonly data: A;
}

export interface JsonCollection<A> {
  /**
   * Read one entry. Missing is `Option.none` — never an error, and never
   * seeded. An entry at an older version is migrated and written back.
   */
  readonly get: (id: string) => Effect.Effect<Option.Option<A>, JsonStoreLoadError>;
  /** Create or replace one entry: encode with the current schema, write atomically. */
  readonly put: (
    id: string,
    value: A,
  ) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** Delete one entry; missing is a no-op. */
  readonly remove: (id: string) => Effect.Effect<void, JsonStoreWriteError>;
  /**
   * All entries, sorted by id. Files that vanish between listing and reading
   * are skipped; a corrupt entry fails the whole list (catch by tag to
   * handle). A missing collection directory is an empty list.
   */
  readonly list: (
    filter?: (entry: JsonCollectionEntry<A>) => boolean,
  ) => Effect.Effect<ReadonlyArray<JsonCollectionEntry<A>>, JsonStoreLoadError>;
}

export interface JsonCollectionOptions<
  Latest extends AnySchema,
  Steps extends ReadonlyArray<AnySchema>,
  Legacy extends AnySchema,
> {
  /** Absolute path of the collection directory; entries live at `<dir>/<id>.json`. */
  readonly dir: string;
  /** The current schema; the collection's entry type is `Latest["Type"]`. */
  readonly schema: Latest;
  /** Superseded versions, oldest first — same contract as `makeJsonDocument`. */
  readonly migrations?: { readonly [K in keyof Steps]: MigrationStep<Steps[K]> };
  /**
   * Adoption path for pre-envelope entries — same contract as
   * `makeJsonDocument`: an entry failing the envelope decode is decoded with
   * this schema, `migrate`d into the version-1 shape, and written back in
   * envelope form on first read.
   */
  readonly legacy?: MigrationStep<Legacy>;
}

/** Bounded fan-out for `list` so huge collections don't exhaust file handles. */
const LIST_CONCURRENCY = 16;

/**
 * Open a JSON collection — a directory of keyed entries (`<dir>/<id>.json`),
 * sharing the document engine's envelope format, schema validation, versioned
 * migrations, and atomic writes, but with record semantics: no eager load, no
 * cache, no defaults. Ids may contain `/` to nest entries in subdirectories
 * (e.g. `"<projectId>/<sessionId>"`).
 */
export const makeJsonCollection = <
  Latest extends AnySchema,
  const Steps extends ReadonlyArray<AnySchema> = readonly [],
  Legacy extends AnySchema = AnySchema,
>(
  options: JsonCollectionOptions<Latest, Steps, Legacy>,
): Effect.Effect<JsonCollection<Latest["Type"]>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    type A = Latest["Type"];
    const { dir, schema } = options;
    const migrations = (options.migrations ?? []) as ReadonlyArray<MigrationStep<AnySchema>>;
    const fs = yield* FileSystem.FileSystem;
    const codec = makeFileCodec(
      fs,
      schema,
      migrations,
      options.legacy as MigrationStep<AnySchema> | undefined,
    );

    const isValidId = (id: string): boolean =>
      id.length > 0 &&
      !path.isAbsolute(id) &&
      id.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

    const fileOf = (id: string): Effect.Effect<string> =>
      isValidId(id)
        ? Effect.succeed(path.join(dir, `${id}.json`))
        : Effect.die(new Error(`invalid collection id: ${JSON.stringify(id)}`));

    const get = (id: string): Effect.Effect<Option.Option<A>, JsonStoreLoadError> =>
      fileOf(id).pipe(
        Effect.flatMap((file) => codec.load(file)),
        Effect.map((value) => (value === undefined ? Option.none<A>() : Option.some(value as A))),
      );

    const listIds: Effect.Effect<ReadonlyArray<string>, JsonStoreReadError> = fs
      .readDirectory(dir, { recursive: true })
      .pipe(
        Effect.map((entries) =>
          entries
            .map((entry) => entry.replaceAll("\\", "/"))
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => entry.slice(0, -".json".length)),
        ),
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed([])
            : Effect.fail(new JsonStoreReadError({ file: dir, cause: error })),
        ),
      );

    return {
      get,
      put: (id, value) => fileOf(id).pipe(Effect.flatMap((file) => codec.save(file, value))),
      remove: (id) =>
        fileOf(id).pipe(
          Effect.flatMap((file) =>
            fs
              .remove(file)
              .pipe(
                Effect.catch((error) =>
                  error.reason._tag === "NotFound"
                    ? Effect.void
                    : Effect.fail(new JsonStoreWriteError({ file, cause: error })),
                ),
              ),
          ),
        ),
      list: (filter) =>
        Effect.gen(function* () {
          const ids = yield* listIds;
          const loaded = yield* Effect.all(
            ids.map((id) =>
              get(id).pipe(
                Effect.map(Option.map((data): JsonCollectionEntry<A> => ({ id, data }))),
              ),
            ),
            { concurrency: LIST_CONCURRENCY },
          );
          const entries = loaded.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
          entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return filter === undefined ? entries : entries.filter(filter);
        }),
    };
  });
