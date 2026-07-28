import { Effect, FileSystem, Ref, Semaphore } from "effect";

import { type AnySchema, makeFileCodec, type MigrationStep } from "./codec";
import type { JsonStoreEncodeError, JsonStoreLoadError, JsonStoreWriteError } from "./errors";
import { getAtPath, type KeyPath, type KeyPathValue, setAtPath } from "./path";

export interface JsonDocument<A> {
  /** Current value from the in-memory cache; never fails. */
  readonly get: Effect.Effect<A>;
  /** Replace the whole value: encode with the current schema, write atomically, update the cache. */
  readonly set: (value: A) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** Serialized read-modify-write; returns the new value. `f` must be pure. */
  readonly update: (
    f: (current: A) => A,
  ) => Effect.Effect<A, JsonStoreEncodeError | JsonStoreWriteError>;
  /** Read one field by typed dot-notation path, e.g. `getKey("appearance.fontSize")`. */
  readonly getKey: <P extends KeyPath<A>>(path: P) => Effect.Effect<KeyPathValue<A, P>>;
  /** Replace one field by typed dot-notation path; persists the whole value. */
  readonly setKey: <P extends KeyPath<A>>(
    path: P,
    value: KeyPathValue<A, P>,
  ) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** Re-read the file (running migrations if needed) and refresh the cache. */
  readonly load: Effect.Effect<A, JsonStoreLoadError>;
}

export interface JsonDocumentOptions<
  Latest extends AnySchema,
  Steps extends ReadonlyArray<AnySchema>,
  Legacy extends AnySchema,
> {
  /** Absolute path of the JSON file. */
  readonly path: string;
  /** The current schema; the document's value type is `Latest["Type"]`. */
  readonly schema: Latest;
  /**
   * Superseded versions, oldest first: the entry at index i is version i+1,
   * and the current `schema` is version `migrations.length + 1`. Versions are
   * implicit in the order, so gaps and duplicates cannot exist. Omit for a
   * document that has never changed shape.
   */
  readonly migrations?: { readonly [K in keyof Steps]: MigrationStep<Steps[K]> };
  /**
   * Adoption path for a pre-envelope file: a file whose JSON fails the
   * `{ version, data }` envelope decode is decoded with this schema instead,
   * `migrate`d into the version-1 shape, run through the normal chain, and
   * written back in envelope form. Without it such a file is a
   * {@link JsonStoreFormatError}.
   */
  readonly legacy?: MigrationStep<Legacy>;
  /** Seed value written when the file does not exist yet. Treated as immutable. */
  readonly defaults: Latest["Type"];
}

/**
 * Open a single versioned JSON document — a standalone file with a seed value,
 * loaded eagerly: a missing file is seeded with `defaults` immediately, an
 * outdated file is migrated step by step in memory (each step's output is
 * validated against the next version's schema) and written back once, and a
 * file from a newer version fails with {@link JsonStoreVersionTooNewError}
 * without ever being touched. Corrupt files fail loudly and are never reset.
 *
 * For dynamic sets of keyed records, use `makeJsonCollection` instead.
 *
 * The document is generic, so it ships no Context tag — wrap it in one per
 * concrete config:
 *
 * ```ts
 * class SettingsStore extends Context.Service<SettingsStore, JsonDocument<Settings>>()(
 *   "SettingsStore",
 * ) {}
 *
 * const SettingsStoreLayer = Layer.effect(
 *   SettingsStore,
 *   makeJsonDocument({ path: settingsPath, schema: SettingsV2, migrations: [...], defaults }),
 * ).pipe(Layer.provide(NodeFileSystem.layer));
 * ```
 */
export const makeJsonDocument = <
  Latest extends AnySchema,
  const Steps extends ReadonlyArray<AnySchema> = readonly [],
  Legacy extends AnySchema = AnySchema,
>(
  options: JsonDocumentOptions<Latest, Steps, Legacy>,
): Effect.Effect<JsonDocument<Latest["Type"]>, JsonStoreLoadError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    type A = Latest["Type"];
    const { defaults, path: file, schema } = options;
    const migrations = (options.migrations ?? []) as ReadonlyArray<MigrationStep<AnySchema>>;
    const fs = yield* FileSystem.FileSystem;
    const codec = makeFileCodec(
      fs,
      schema,
      migrations,
      options.legacy as MigrationStep<AnySchema> | undefined,
    );

    const loadFromDisk: Effect.Effect<A, JsonStoreLoadError> = codec
      .load(file)
      .pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? codec.save(file, defaults).pipe(Effect.as(defaults))
            : Effect.succeed(value as A),
        ),
      );

    const initial = yield* loadFromDisk;
    const ref = yield* Ref.make(initial);
    const semaphore = yield* Semaphore.make(1);

    const update = (
      f: (current: A) => A,
    ): Effect.Effect<A, JsonStoreEncodeError | JsonStoreWriteError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const next = f(yield* Ref.get(ref));
          yield* codec.save(file, next);
          yield* Ref.set(ref, next);
          return next;
        }),
      );

    return {
      get: Ref.get(ref),
      set: (value) => Effect.asVoid(update(() => value)),
      update,
      getKey: (key) =>
        Ref.get(ref).pipe(
          Effect.map((value) => getAtPath(value, key) as KeyPathValue<A, typeof key>),
        ),
      setKey: (key, leaf) =>
        Effect.asVoid(update((current) => setAtPath(current, key.split("."), leaf) as A)),
      load: semaphore.withPermit(loadFromDisk.pipe(Effect.tap((value) => Ref.set(ref, value)))),
    };
  });
