import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { StoreReadError, StoreWriteError } from "../errors";

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Read a JSON file, returning `fallback` if it does not exist yet.
 * A malformed or unreadable existing file fails with `StoreReadError`.
 */
export const readJson = <A>(file: string, fallback: A): Effect.Effect<A, StoreReadError> =>
  Effect.tryPromise({
    try: async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (cause) {
        if (isEnoent(cause)) return fallback;
        throw cause;
      }
      return JSON.parse(raw) as A;
    },
    catch: (cause) => new StoreReadError({ file, cause }),
  });

/**
 * Write JSON via "temp file + atomic rename" so a crash mid-write can never
 * leave a half-written / corrupt file. Creates parent dirs as needed.
 */
export const writeJsonAtomic = (
  file: string,
  data: unknown,
): Effect.Effect<void, StoreWriteError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    },
    catch: (cause) => new StoreWriteError({ file, cause }),
  });

/**
 * Read every `*.json` file in a directory, parsed as `A`. A missing directory
 * yields `[]` (the collection just hasn't been written to yet). A malformed
 * file fails the whole read with `StoreReadError`.
 */
export const readJsonDir = <A>(dir: string): Effect.Effect<ReadonlyArray<A>, StoreReadError> =>
  Effect.tryPromise({
    try: async () => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (cause) {
        if (isEnoent(cause)) return [];
        throw cause;
      }
      const out: A[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const raw = await readFile(join(dir, name), "utf8");
        out.push(JSON.parse(raw) as A);
      }
      return out;
    },
    catch: (cause) => new StoreReadError({ file: dir, cause }),
  });

/** Delete a file. A file that is already gone is not an error. */
export const removeFile = (file: string): Effect.Effect<void, StoreWriteError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await rm(file);
      } catch (cause) {
        if (!isEnoent(cause)) throw cause;
      }
    },
    catch: (cause) => new StoreWriteError({ file, cause }),
  });
