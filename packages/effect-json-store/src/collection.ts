import path from "node:path";

import { Effect, FileSystem, Option, Semaphore } from "effect";

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

export interface JsonCollectionListOptions<A> {
  /**
   * Restrict to entries under one subdirectory (an id prefix), e.g.
   * `under: "p1"` reads only `<dir>/p1/**`. Entries outside it — including
   * corrupt ones — are never touched.
   */
  readonly under?: string;
  readonly filter?: (entry: JsonCollectionEntry<A>) => boolean;
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
   * All entry ids (optionally scoped with `under`), sorted, without reading
   * any entry bodies. Non-id filenames (e.g. a stray `.json`) are skipped.
   * A missing directory is an empty list.
   */
  readonly ids: (
    options?: Pick<JsonCollectionListOptions<A>, "under">,
  ) => Effect.Effect<ReadonlyArray<string>, JsonStoreReadError>;
  /**
   * All entries, sorted by id. Files that vanish between listing and reading
   * are skipped; a corrupt entry fails the whole list (catch by tag to
   * handle; scope with `under` to contain the blast radius). A missing
   * directory is an empty list.
   */
  readonly list: (
    options?: JsonCollectionListOptions<A>,
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
 *
 * Ids are the caller's responsibility: an invalid id (empty/absolute/dot
 * segments) is a defect, so sanitize untrusted input before it gets here.
 *
 * Operations on the same id are serialized within this collection instance —
 * `get`'s migration/adoption write-back can therefore never overwrite a
 * concurrent `put` or resurrect a concurrent `remove`. Distinct ids stay
 * fully concurrent; cross-instance and cross-process writes are not covered.
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

    // One mutex per id, created on first touch. Grows with the number of
    // distinct ids used over the instance's lifetime — fine for file-backed
    // collections, whose id sets are small.
    const locks = new Map<string, Semaphore.Semaphore>();
    const withIdLock =
      (id: string) =>
      <X, E, R>(effect: Effect.Effect<X, E, R>): Effect.Effect<X, E, R> =>
        Effect.suspend(() => {
          let lock = locks.get(id);
          if (lock === undefined) {
            lock = Semaphore.makeUnsafe(1);
            locks.set(id, lock);
          }
          return lock.withPermit(effect);
        });

    const get = (id: string): Effect.Effect<Option.Option<A>, JsonStoreLoadError> =>
      fileOf(id).pipe(
        Effect.flatMap((file) => withIdLock(id)(codec.load(file))),
        Effect.map((value) => (value === undefined ? Option.none<A>() : Option.some(value as A))),
      );

    const ids = (
      listOptions?: Pick<JsonCollectionListOptions<A>, "under">,
    ): Effect.Effect<ReadonlyArray<string>, JsonStoreReadError> =>
      Effect.suspend(() => {
        const under = listOptions?.under;
        if (under !== undefined && !isValidId(under)) {
          return Effect.die(new Error(`invalid collection id prefix: ${JSON.stringify(under)}`));
        }
        const root = under === undefined ? dir : path.join(dir, under);
        return fs.readDirectory(root, { recursive: true }).pipe(
          Effect.map((entries) =>
            entries
              .map((entry) => entry.replaceAll("\\", "/"))
              .filter((entry) => entry.endsWith(".json"))
              .map((entry) => entry.slice(0, -".json".length))
              .map((entry) => (under === undefined ? entry : `${under}/${entry}`))
              // Skip stray non-id filenames (a bare ".json", dot segments…)
              // instead of letting them die in fileOf later.
              .filter(isValidId)
              .sort(),
          ),
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed([])
              : Effect.fail(new JsonStoreReadError({ file: root, cause: error })),
          ),
        );
      });

    return {
      get,
      ids,
      put: (id, value) =>
        fileOf(id).pipe(Effect.flatMap((file) => withIdLock(id)(codec.save(file, value)))),
      remove: (id) =>
        fileOf(id).pipe(
          Effect.flatMap((file) =>
            withIdLock(id)(
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
        ),
      list: (listOptions) =>
        Effect.gen(function* () {
          const found = yield* ids(listOptions);
          const loaded = yield* Effect.all(
            found.map((id) =>
              get(id).pipe(
                Effect.map(Option.map((data): JsonCollectionEntry<A> => ({ id, data }))),
              ),
            ),
            { concurrency: LIST_CONCURRENCY },
          );
          const entries = loaded.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
          const filter = listOptions?.filter;
          return filter === undefined ? entries : entries.filter(filter);
        }),
    };
  });
