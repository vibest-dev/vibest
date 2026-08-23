import path from "node:path";

import { Context, Effect, FileSystem, Layer, Stream, type PlatformError } from "effect";

import {
  WorkspaceBinaryFile,
  WorkspaceFileNotFound,
  WorkspaceFileTooLarge,
  WorkspaceNotDirectory,
  WorkspaceNotFile,
  WorkspacePathEscape,
  WorkspaceReadError,
} from "../errors";

/** Largest file we will render as text; larger files are rejected, not truncated. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SCAN_CONCURRENCY = 32;
const NUL_BYTE = 0;
const BINARY_MAGIC_PREFIXES: ReadonlyArray<ReadonlyArray<number>> = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // PDF
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  [0x50, 0x4b, 0x03, 0x04], // ZIP
  [0x50, 0x4b, 0x05, 0x06], // Empty ZIP
  [0x1f, 0x8b], // Gzip
  [0x7f, 0x45, 0x4c, 0x46], // ELF
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".terraform",
]);

const EXCLUDED_DIRECTORY_SEQUENCES = [
  [".yarn", "unplugged"],
  ["vendor", "bundle"],
] as const;

/** Is `child` at or beneath `parent`? */
const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const isNotFound = (cause: PlatformError.PlatformError): boolean =>
  cause.reason._tag === "NotFound";

const hasBinaryMagicPrefix = (bytes: Uint8Array): boolean =>
  BINARY_MAGIC_PREFIXES.some(
    (prefix) =>
      bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte),
  );

const shouldExcludeDirectory = (relativePath: string, name: string): boolean => {
  if (EXCLUDED_DIRECTORY_NAMES.has(name)) return true;
  const segments = relativePath.split("/");
  return EXCLUDED_DIRECTORY_SEQUENCES.some((sequence) => {
    if (segments.length < sequence.length) return false;
    const offset = segments.length - sequence.length;
    return sequence.every((segment, index) => segments[offset + index] === segment);
  });
};

type ReadFileError =
  | WorkspacePathEscape
  | WorkspaceFileNotFound
  | WorkspaceNotFile
  | WorkspaceFileTooLarge
  | WorkspaceBinaryFile
  | WorkspaceReadError;

type ReadTreeError = WorkspacePathEscape | WorkspaceNotDirectory | WorkspaceReadError;

export type WorkspaceSymlinkTarget = "file" | "directory" | "broken" | "outside" | "other";

export type WorkspaceTreeEntry =
  | { readonly path: string; readonly type: "directory" | "file" }
  | {
      readonly path: string;
      readonly type: "symlink";
      readonly symlinkTarget: WorkspaceSymlinkTarget;
    };

export interface WorkspaceTreeResult {
  readonly entries: ReadonlyArray<WorkspaceTreeEntry>;
}

interface ScanCandidate {
  readonly absolutePath: string;
  readonly name: string;
  readonly relativePath: string;
}

/**
 * Read-only workspace filesystem module. It hides path confinement, scan
 * exclusions, bounded traversal, symlink classification, size limits, and
 * binary detection behind two operations used by the RPC adapter.
 */
export class FileSystemService extends Context.Service<
  FileSystemService,
  {
    readonly readFileString: (cwd: string, path: string) => Effect.Effect<string, ReadFileError>;
    readonly readTree: (cwd: string) => Effect.Effect<WorkspaceTreeResult, ReadTreeError>;
  }
>()("FileSystemService") {}

export const FileSystemServiceLayer: Layer.Layer<FileSystemService, never, FileSystem.FileSystem> =
  Layer.effect(
    FileSystemService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const readError = (relativePath: string) => (cause: unknown) =>
        new WorkspaceReadError({ path: relativePath, cause });

      const fileReadError = (relativePath: string) => (cause: PlatformError.PlatformError) =>
        isNotFound(cause)
          ? new WorkspaceFileNotFound({ path: relativePath })
          : new WorkspaceReadError({ path: relativePath, cause });

      const resolveRoot = (cwd: string) =>
        Effect.gen(function* () {
          if (!path.isAbsolute(cwd)) {
            return yield* new WorkspacePathEscape({ cwd, path: "." });
          }
          const realRoot = yield* fs.realPath(cwd).pipe(Effect.mapError(readError(".")));
          const info = yield* fs.stat(realRoot).pipe(Effect.mapError(readError(".")));
          if (info.type !== "Directory") {
            return yield* new WorkspaceNotDirectory({ path: "." });
          }
          return realRoot;
        });

      const resolveFileWithin = (cwd: string, relativePath: string) =>
        Effect.gen(function* () {
          if (!path.isAbsolute(cwd) || path.isAbsolute(relativePath)) {
            return yield* new WorkspacePathEscape({ cwd, path: relativePath });
          }
          const absolutePath = path.resolve(cwd, relativePath);
          if (!contains(cwd, absolutePath)) {
            return yield* new WorkspacePathEscape({ cwd, path: relativePath });
          }
          const realRoot = yield* fs
            .realPath(cwd)
            .pipe(Effect.mapError(fileReadError(relativePath)));
          const realTarget = yield* fs
            .realPath(absolutePath)
            .pipe(Effect.mapError(fileReadError(relativePath)));
          if (!contains(realRoot, realTarget)) {
            return yield* new WorkspacePathEscape({ cwd, path: relativePath });
          }
          return realTarget;
        });

      const classifySymlink = (
        realRoot: string,
        absolutePath: string,
      ): Effect.Effect<WorkspaceSymlinkTarget> =>
        fs.realPath(absolutePath).pipe(
          Effect.flatMap((realTarget) => {
            if (!contains(realRoot, realTarget)) {
              return Effect.succeed<WorkspaceSymlinkTarget>("outside");
            }
            return fs.stat(realTarget).pipe(
              Effect.map((info): WorkspaceSymlinkTarget => {
                if (info.type === "File") return "file";
                if (info.type === "Directory") return "directory";
                return "other";
              }),
              Effect.catch(() => Effect.succeed<WorkspaceSymlinkTarget>("broken")),
            );
          }),
          Effect.catch(() => Effect.succeed<WorkspaceSymlinkTarget>("broken")),
        );

      const readTree = (cwd: string): Effect.Effect<WorkspaceTreeResult, ReadTreeError> =>
        Effect.gen(function* () {
          const realRoot = yield* resolveRoot(cwd);
          const entries: WorkspaceTreeEntry[] = [];
          let pendingDirectories = [""];

          while (pendingDirectories.length > 0) {
            const currentDirectories = pendingDirectories;
            pendingDirectories = [];

            const directoryCandidates = yield* Effect.forEach(
              currentDirectories,
              (relativeDirectory) => {
                const absoluteDirectory = relativeDirectory
                  ? path.join(cwd, relativeDirectory)
                  : cwd;
                const listDirectory = Effect.gen(function* () {
                  const realDirectory = yield* fs.realPath(absoluteDirectory);
                  if (!contains(realRoot, realDirectory)) return [];
                  const names = yield* fs.readDirectory(absoluteDirectory);
                  names.sort((left, right) =>
                    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
                  );
                  return names.map(
                    (name): ScanCandidate => ({
                      absolutePath: path.join(absoluteDirectory, name),
                      name,
                      relativePath: toPosixPath(
                        relativeDirectory ? path.join(relativeDirectory, name) : name,
                      ),
                    }),
                  );
                });

                if (relativeDirectory === "") {
                  return listDirectory.pipe(Effect.mapError(readError(".")));
                }
                // Keep the directory itself visible if one subtree becomes
                // unreadable or disappears during a scan; omit only descendants.
                return listDirectory.pipe(Effect.catch(() => Effect.succeed<ScanCandidate[]>([])));
              },
              { concurrency: SCAN_CONCURRENCY },
            );

            const classified = yield* Effect.forEach(
              directoryCandidates.flat(),
              (candidate) => {
                // Effect FileSystem.stat follows links on Node. Probe readLink
                // first so links remain visible leaves instead of inheriting
                // their target kind and accidentally entering the scan queue.
                const classifyRegularEntry = fs.stat(candidate.absolutePath).pipe(
                  Effect.map((info): WorkspaceTreeEntry | undefined => {
                    // Git worktrees represent metadata as a `.git` file while
                    // regular repositories use a directory. Hide both regular
                    // forms, but retain `.git` symlinks as non-recursive leaves.
                    if (candidate.name === ".git") return undefined;
                    if (info.type === "Directory") {
                      if (shouldExcludeDirectory(candidate.relativePath, candidate.name)) {
                        return undefined;
                      }
                      pendingDirectories.push(candidate.relativePath);
                      return { path: candidate.relativePath, type: "directory" };
                    }
                    if (info.type === "File") {
                      return { path: candidate.relativePath, type: "file" };
                    }
                    return undefined;
                  }),
                  Effect.catch(() => Effect.succeed(undefined)),
                );

                return fs.readLink(candidate.absolutePath).pipe(
                  Effect.flatMap(() =>
                    classifySymlink(realRoot, candidate.absolutePath).pipe(
                      Effect.map(
                        (symlinkTarget): WorkspaceTreeEntry => ({
                          path: candidate.relativePath,
                          type: "symlink",
                          symlinkTarget,
                        }),
                      ),
                    ),
                  ),
                  Effect.catch(() => classifyRegularEntry),
                );
              },
              { concurrency: SCAN_CONCURRENCY },
            );

            entries.push(
              ...classified.filter((entry): entry is WorkspaceTreeEntry => entry !== undefined),
            );
          }

          entries.sort((left, right) =>
            left.path.localeCompare(right.path, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
          return { entries };
        });

      return {
        readFileString: (cwd, relativePath) =>
          Effect.gen(function* () {
            const realTarget = yield* resolveFileWithin(cwd, relativePath);
            const info = yield* fs
              .stat(realTarget)
              .pipe(Effect.mapError(fileReadError(relativePath)));
            if (info.type !== "File") {
              return yield* new WorkspaceNotFile({ path: relativePath });
            }
            const size = Number(info.size);
            if (size > MAX_FILE_BYTES) {
              return yield* new WorkspaceFileTooLarge({
                path: relativePath,
                size,
                limit: MAX_FILE_BYTES,
              });
            }
            const chunks = yield* fs
              .stream(realTarget, { bytesToRead: MAX_FILE_BYTES + 1 })
              .pipe(Stream.runCollect, Effect.mapError(fileReadError(relativePath)));
            const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            if (byteLength > MAX_FILE_BYTES) {
              return yield* new WorkspaceFileTooLarge({
                path: relativePath,
                size: Math.max(size, byteLength),
                limit: MAX_FILE_BYTES,
              });
            }
            const bytes = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            if (bytes.includes(NUL_BYTE) || hasBinaryMagicPrefix(bytes)) {
              return yield* new WorkspaceBinaryFile({ path: relativePath });
            }
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              return yield* new WorkspaceBinaryFile({ path: relativePath });
            }
          }),
        readTree,
      };
    }),
  );
