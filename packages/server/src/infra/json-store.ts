import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { StoreReadError, StoreWriteError } from "../errors";

export const isEnoent = (cause: unknown): boolean =>
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
        raw = await fs.readFile(file, "utf8");
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
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await fs.rename(tmp, file);
    },
    catch: (cause) => new StoreWriteError({ file, cause }),
  });
