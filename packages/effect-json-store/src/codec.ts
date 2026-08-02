import { Effect, type FileSystem, Option, Schema } from "effect";

import { writeFileAtomic } from "./atomic";
import {
  JsonStoreDecodeError,
  JsonStoreEncodeError,
  JsonStoreFormatError,
  type JsonStoreLoadError,
  JsonStoreMigrationError,
  JsonStoreParseError,
  JsonStoreReadError,
  JsonStoreVersionTooNewError,
  JsonStoreWriteError,
} from "./errors";

/**
 * Any schema whose decode/encode needs no services. Documents and collections
 * require this so their methods never leak a requirements channel.
 */
export type AnySchema = Schema.Codec<unknown, unknown, never, never>;

/**
 * One superseded version: its schema, plus the migration out of it. `migrate`
 * receives data valid under this entry's own schema — pairing the two in one
 * object is what lets TypeScript infer `data` without annotations — and
 * returns the next version's shape, which is validated at runtime against the
 * next schema before continuing.
 */
export interface MigrationStep<S extends AnySchema> {
  readonly schema: S;
  readonly migrate: (data: S["Type"]) => unknown;
}

/**
 * On-disk shape: `{ "version": n, "data": { ... } }`. The envelope keeps the
 * version outside user data (no reserved field names) and lets the engine pick
 * the right version schema before touching `data`.
 */
const Envelope = Schema.Struct({
  version: Schema.Int,
  data: Schema.Unknown,
});

/** @internal Per-file engine shared by documents and collections. */
export interface FileCodec {
  /**
   * Read, validate, and migrate one file. Returns `undefined` when the file
   * does not exist (`JSON.parse` can never produce `undefined`, so the signal
   * is unambiguous). A file at an older version is migrated in memory and
   * written back atomically before returning.
   */
  readonly load: (file: string) => Effect.Effect<unknown | undefined, JsonStoreLoadError>;
  /** Encode with the current schema (doubles as validation) and write atomically. */
  readonly save: (
    file: string,
    value: unknown,
  ) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
}

/** @internal */
export const makeFileCodec = (
  fs: FileSystem.FileSystem,
  schema: AnySchema,
  migrations: ReadonlyArray<MigrationStep<AnySchema>>,
  legacy?: MigrationStep<AnySchema>,
): FileCodec => {
  const latestVersion = migrations.length + 1;

  const versionSchema = (version: number): AnySchema | undefined =>
    version === latestVersion ? schema : migrations[version - 1]?.schema;

  const writeAtomic = (
    file: string,
    envelope: { readonly version: number; readonly data: unknown },
  ): Effect.Effect<void, JsonStoreWriteError> =>
    Effect.gen(function* () {
      // Schema encoding cannot rule out values JSON.stringify rejects (BigInt,
      // cycles behind Schema.Unknown), so the throw must stay a typed failure.
      const text = yield* Effect.try({
        try: () => `${JSON.stringify(envelope, null, 2)}\n`,
        catch: (cause) => cause,
      });
      yield* writeFileAtomic(fs, file, text);
    }).pipe(Effect.mapError((cause) => new JsonStoreWriteError({ file, cause })));

  const save: FileCodec["save"] = (file, value) =>
    Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError((cause) => new JsonStoreEncodeError({ file, cause })),
      Effect.flatMap((data) => writeAtomic(file, { version: latestVersion, data })),
    );

  const readRaw = (file: string): Effect.Effect<string | undefined, JsonStoreReadError> =>
    fs.readFileString(file).pipe(
      Effect.map((raw): string | undefined => raw),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(new JsonStoreReadError({ file, cause: error })),
      ),
    );

  const migrateStep = (
    file: string,
    step: MigrationStep<AnySchema>,
    input: unknown,
    fromVersion: number,
  ): Effect.Effect<unknown, JsonStoreMigrationError> =>
    Effect.gen(function* () {
      const toVersion = fromVersion + 1;
      const next = versionSchema(toVersion);
      if (next === undefined) {
        return yield* Effect.die(
          new Error(`invariant: missing schema for v${toVersion} while migrating ${file}`),
        );
      }
      const output = yield* Effect.try({
        try: () => step.migrate(input),
        catch: (cause) => new JsonStoreMigrationError({ file, fromVersion, toVersion, cause }),
      });
      // A migration must produce a value valid under the next version's schema;
      // encoding validates the Type side without touching disk.
      yield* Schema.encodeEffect(next)(output).pipe(
        Effect.mapError(
          (cause) => new JsonStoreMigrationError({ file, fromVersion, toVersion, cause }),
        ),
      );
      return output;
    });

  const load: FileCodec["load"] = (file) =>
    Effect.gen(function* () {
      const raw = yield* readRaw(file);
      if (raw === undefined) {
        return undefined;
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new JsonStoreParseError({ file, cause }),
      });
      // A file that fails the envelope decode is a pre-envelope (legacy) file
      // when `legacy` is configured, and a format error otherwise.
      const envelope = yield* Schema.decodeUnknownEffect(Envelope)(parsed).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          legacy === undefined
            ? Effect.fail(new JsonStoreFormatError({ file, cause }))
            : Effect.succeed(Option.none<typeof Envelope.Type>()),
        ),
      );

      // The version the on-disk bytes were decoded at; 0 marks a legacy file.
      let version: number;
      let value: unknown;
      if (Option.isSome(envelope)) {
        version = envelope.value.version;
        if (version > latestVersion) {
          return yield* Effect.fail(
            new JsonStoreVersionTooNewError({ file, fileVersion: version, latestVersion }),
          );
        }
        const fileSchema = versionSchema(version);
        if (fileSchema === undefined) {
          return yield* Effect.fail(
            new JsonStoreFormatError({
              file,
              cause: `version must be a positive integer, got ${version}`,
            }),
          );
        }
        value = yield* Schema.decodeUnknownEffect(fileSchema)(envelope.value.data).pipe(
          Effect.mapError((cause) => new JsonStoreDecodeError({ file, version, cause })),
        );
      } else if (legacy !== undefined) {
        version = 0;
        const legacyValue = yield* Schema.decodeUnknownEffect(legacy.schema)(parsed).pipe(
          Effect.mapError((cause) => new JsonStoreDecodeError({ file, version: 0, cause })),
        );
        value = yield* migrateStep(file, legacy, legacyValue, 0);
      } else {
        return yield* Effect.die(
          new Error(
            `invariant: ${file} missed the envelope decode with no legacy schema configured`,
          ),
        );
      }

      for (let from = Math.max(version, 1); from < latestVersion; from++) {
        const step = migrations[from - 1];
        if (step === undefined) {
          return yield* Effect.die(
            new Error(`invariant: missing migration for v${from} while migrating ${file}`),
          );
        }
        value = yield* migrateStep(file, step, value, from);
      }
      // Legacy adoption (version 0) always writes back, even at a chain of one.
      if (version < latestVersion) {
        yield* save(file, value);
      }
      return value;
    });

  return { load, save };
};
