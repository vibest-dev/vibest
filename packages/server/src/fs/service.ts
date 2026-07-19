import { isAbsolute, relative, resolve, sep } from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Context, Effect, FileSystem, Layer } from "effect";

import {
  WorkspaceBinaryFile,
  WorkspaceFileTooLarge,
  WorkspaceNotFile,
  WorkspacePathEscape,
  WorkspaceReadError,
} from "../errors";

/** Largest file we will read as text; larger files are rejected, not truncated. */
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** A NUL byte marks the content as binary, so we refuse to read it as text. */
const NUL = String.fromCharCode(0);

/**
 * Lexical containment: is `child` at or beneath `parent`? Rejects `..` escapes
 * and absolute paths that point elsewhere. (Same check opencode's `FSUtil.contains`
 * and t3code's `WorkspacePaths` use.)
 */
const contains = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

type ReadFileError =
  | WorkspacePathEscape
  | WorkspaceNotFile
  | WorkspaceFileTooLarge
  | WorkspaceBinaryFile
  | WorkspaceReadError;

/**
 * `FileSystemService` — read-only file access confined to a caller-supplied
 * `cwd`. Built on the effect `FileSystem`, but unlike a raw passthrough it
 * enforces a path boundary (lexical + realpath, defeating `..` and symlink
 * escapes) and read guardrails (regular-file-only, size cap, binary rejection).
 * All failures are typed on the effect error channel.
 */
export class FileSystemService extends Context.Service<
  FileSystemService,
  {
    /** Read `path` (relative to `cwd`) as UTF-8 text. */
    readonly readFileString: (cwd: string, path: string) => Effect.Effect<string, ReadFileError>;
  }
>()("FileSystemService") {}

export const FileSystemServiceLayer: Layer.Layer<FileSystemService> = Layer.effect(
  FileSystemService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const readErr = (path: string) => (cause: unknown) => new WorkspaceReadError({ path, cause });

    // Resolve `path` against `cwd` and confine it there both lexically and after
    // realpath — the first stops `..`, the second stops symlinks pointing out.
    const resolveWithin = (cwd: string, path: string) =>
      Effect.gen(function* () {
        // `cwd` is the trusted root and must be absolute; `path` must be relative
        // to it (an absolute `path` would silently ignore `cwd`).
        if (!isAbsolute(cwd) || isAbsolute(path)) {
          return yield* new WorkspacePathEscape({ cwd, path });
        }
        const absolute = resolve(cwd, path);
        if (!contains(cwd, absolute)) {
          return yield* new WorkspacePathEscape({ cwd, path });
        }
        const realRoot = yield* fs.realPath(cwd).pipe(Effect.mapError(readErr(path)));
        const realTarget = yield* fs.realPath(absolute).pipe(Effect.mapError(readErr(path)));
        if (!contains(realRoot, realTarget)) {
          return yield* new WorkspacePathEscape({ cwd, path });
        }
        return absolute;
      });

    return {
      readFileString: (cwd, path) =>
        Effect.gen(function* () {
          const absolute = yield* resolveWithin(cwd, path);
          const info = yield* fs.stat(absolute).pipe(Effect.mapError(readErr(path)));
          if (info.type !== "File") {
            return yield* new WorkspaceNotFile({ path });
          }
          const size = Number(info.size);
          if (size > MAX_FILE_BYTES) {
            return yield* new WorkspaceFileTooLarge({ path, size, limit: MAX_FILE_BYTES });
          }
          const content = yield* fs.readFileString(absolute).pipe(Effect.mapError(readErr(path)));
          if (content.includes(NUL)) {
            return yield* new WorkspaceBinaryFile({ path });
          }
          return content;
        }),
    };
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
