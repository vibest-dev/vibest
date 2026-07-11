import { Context, Effect, Layer } from "effect";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { FileReadError } from "../errors";

export interface GrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const IGNORED = new Set([".git", "node_modules"]);

/** Recursively collect file paths under `dir` (absolute), skipping IGNORED dirs. */
const walk = async (dir: string): Promise<Array<string>> => {
  const out: Array<string> = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name)) continue;
      out.push(...(await walk(join(dir, entry.name))));
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

/**
 * `fs` module — read-only file access. No write/watch operations and (for now)
 * no path-boundary protection (design §8).
 */
export class FSService extends Context.Service<
  FSService,
  {
    readonly readFile: (path: string) => Effect.Effect<string, FileReadError>;
    /** Recursive listing of files under `dir`, as paths relative to `dir`. */
    readonly tree: (dir: string) => Effect.Effect<ReadonlyArray<string>, FileReadError>;
    /** Substring search over file contents under `dir`. */
    readonly grep: (
      pattern: string,
      dir: string,
    ) => Effect.Effect<ReadonlyArray<GrepMatch>, FileReadError>;
    /** Search file paths (not contents) under `dir` by substring. */
    readonly search: (
      query: string,
      dir: string,
    ) => Effect.Effect<ReadonlyArray<string>, FileReadError>;
  }
>()("FSService") {}

export const FSServiceLayer: Layer.Layer<FSService> = Layer.sync(FSService, () => ({
  readFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => new FileReadError({ path, cause }),
    }),

  tree: (dir) =>
    Effect.tryPromise({
      try: async () => {
        const files = await walk(dir);
        return files.map((f) => relative(dir, f));
      },
      catch: (cause) => new FileReadError({ path: dir, cause }),
    }),

  grep: (pattern, dir) =>
    Effect.tryPromise({
      try: async () => {
        const files = await walk(dir);
        const matches: Array<GrepMatch> = [];
        for (const file of files) {
          let content: string;
          try {
            content = await readFile(file, "utf8");
          } catch {
            continue; // skip unreadable/binary files
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const text = lines[i] ?? "";
            if (text.includes(pattern)) {
              matches.push({ file: relative(dir, file), line: i + 1, text });
            }
          }
        }
        return matches;
      },
      catch: (cause) => new FileReadError({ path: dir, cause }),
    }),

  search: (query, dir) =>
    Effect.tryPromise({
      try: async () => {
        const files = await walk(dir);
        return files.map((f) => relative(dir, f)).filter((p) => p.includes(query));
      },
      catch: (cause) => new FileReadError({ path: dir, cause }),
    }),
}));
