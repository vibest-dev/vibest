import path from "node:path";

import type {
  GitBranch,
  GitDiffQuery,
  GitFileDiff,
  GitReview,
  GitReviewFile,
  GitReviewMode,
  GitReviewQuery,
  GitStatus,
  GitStatusFile,
} from "@vibest/contract/git";
import { Context, Effect, FileSystem, Layer } from "effect";
import { simpleGit } from "simple-git";

import {
  GitError,
  GitNotRepository,
  GitRefNotFound,
  WorkspaceBinaryFile,
  WorkspaceFileNotFound,
  WorkspaceFileTooLarge,
  WorkspaceNotDirectory,
  WorkspaceNotFile,
  WorkspacePathEscape,
  WorkspaceReadError,
} from "../errors";
import { FileSystemService } from "../fs";
import { parseNameStatus, parseNulPaths } from "./name-status";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const NUL_BYTE = 0;
const BINARY_MAGIC_PREFIXES: ReadonlyArray<ReadonlyArray<number>> = [
  [0x25, 0x50, 0x44, 0x46, 0x2d],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x1f, 0x8b],
  [0x7f, 0x45, 0x4c, 0x46],
];
const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk"] as const;

const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const toPosixPath = (value: string): string => value.split(path.sep).join("/");

const hasBinaryMagicPrefix = (bytes: Uint8Array): boolean =>
  BINARY_MAGIC_PREFIXES.some(
    (prefix) =>
      bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte),
  );

const isNotRepositoryMessage = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /not a git repository/i.test(message);
};

const decodeText = (
  bytes: Uint8Array,
  relativePath: string,
): Effect.Effect<string, WorkspaceBinaryFile> => {
  if (bytes.includes(NUL_BYTE) || hasBinaryMagicPrefix(bytes)) {
    return Effect.fail(new WorkspaceBinaryFile({ path: relativePath }));
  }
  try {
    return Effect.succeed(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return Effect.fail(new WorkspaceBinaryFile({ path: relativePath }));
  }
};

/** Reject anything that is not a listed ref name — no `../`, flags, or rev magic. */
const isUnsafeRef = (ref: string): boolean =>
  ref === "" ||
  ref.startsWith("-") ||
  ref.includes("..") ||
  ref.includes("\\") ||
  ref.includes("\0") ||
  ref.includes(":") ||
  ref.includes("@{") ||
  /\s/.test(ref);

type GitFailure =
  | WorkspacePathEscape
  | WorkspaceNotDirectory
  | WorkspaceReadError
  | GitNotRepository
  | GitError;

type GitReviewFailure = GitFailure | GitRefNotFound;

type GitDiffFailure =
  | GitReviewFailure
  | WorkspaceFileNotFound
  | WorkspaceNotFile
  | WorkspaceBinaryFile
  | WorkspaceFileTooLarge;

type ComparePlan = {
  readonly mode: GitReviewMode;
  readonly other: string | null;
  readonly base: string;
  readonly baseBranch: string | null;
  readonly head: string | null;
  readonly includeUntracked: boolean;
};

/**
 * Read-only `git` module. Workspace confinement matches `FileSystemService`:
 * `cwd` must be an absolute directory, and every path git reports is rewritten
 * relative to that directory (files outside it are dropped).
 */
export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (cwd: string) => Effect.Effect<GitStatus, GitFailure>;
    readonly branch: (cwd: string) => Effect.Effect<GitBranch, GitFailure>;
    readonly review: (query: GitReviewQuery) => Effect.Effect<GitReview, GitReviewFailure>;
    readonly diff: (query: GitDiffQuery) => Effect.Effect<GitFileDiff, GitDiffFailure>;
  }
>()("GitService") {}

export const GitServiceLayer: Layer.Layer<
  GitService,
  never,
  FileSystem.FileSystem | FileSystemService
> = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* FileSystemService;

    const readError = (relativePath: string) => (cause: unknown) =>
      new WorkspaceReadError({ path: relativePath, cause });

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

    const gitError = (cwd: string) => (cause: unknown) =>
      isNotRepositoryMessage(cause) ? new GitNotRepository({ cwd }) : new GitError({ cwd, cause });

    const raw = (cwd: string, args: readonly string[]) =>
      Effect.tryPromise({
        try: () => simpleGit(cwd).raw([...args]),
        catch: gitError(cwd),
      });

    const resolveRepoRoot = (cwd: string) =>
      raw(cwd, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.map((value) => value.trim()),
        Effect.flatMap((toplevel) =>
          toplevel === ""
            ? Effect.fail(new GitNotRepository({ cwd }))
            : Effect.succeed(path.resolve(toplevel)),
        ),
      );

    const toWorkspacePath = (cwd: string, repoRoot: string, gitPath: string): string | null => {
      if (path.isAbsolute(gitPath) || gitPath.split(/[\\/]/).includes("..")) return null;
      const absolute = path.resolve(repoRoot, gitPath);
      if (!contains(cwd, absolute)) return null;
      return toPosixPath(path.relative(cwd, absolute)) || gitPath;
    };

    const relocate = (cwd: string, repoRoot: string, file: GitReviewFile): GitReviewFile | null => {
      const nextPath = toWorkspacePath(cwd, repoRoot, file.path);
      if (nextPath === null) return null;
      if (file.oldPath === undefined) return { ...file, path: nextPath };
      const oldPath = toWorkspacePath(cwd, repoRoot, file.oldPath);
      if (oldPath === null) return { path: nextPath, status: file.status };
      return { path: nextPath, status: file.status, oldPath };
    };

    const parseRefNames = (output: string): string[] => {
      const names: string[] = [];
      for (const line of output.split("\n")) {
        const ref = line.trim();
        if (ref.startsWith("refs/heads/")) {
          names.push(ref.slice("refs/heads/".length));
        } else if (ref.startsWith("refs/remotes/")) {
          names.push(ref.slice("refs/remotes/".length));
        }
      }
      return names;
    };

    const listRefs = (cwd: string) =>
      raw(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).pipe(
        Effect.map((output) => {
          const local: string[] = [];
          const remotes: string[] = [];
          for (const line of output.split("\n")) {
            const ref = line.trim();
            if (ref.startsWith("refs/heads/")) {
              local.push(ref.slice("refs/heads/".length));
            } else if (ref.startsWith("refs/remotes/")) {
              remotes.push(ref.slice("refs/remotes/".length));
            }
          }
          return { local, remotes, all: [...local, ...remotes] };
        }),
      );

    const resolvePreferredCompareRef = (cwd: string) =>
      Effect.gen(function* () {
        const remoteHead = yield* raw(cwd, [
          "symbolic-ref",
          "--quiet",
          "refs/remotes/origin/HEAD",
        ]).pipe(
          Effect.map((value) => value.trim()),
          Effect.catch(() => Effect.succeed("")),
        );
        if (remoteHead.startsWith("refs/remotes/")) {
          return remoteHead.slice("refs/remotes/".length);
        }
        const local = yield* raw(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
        const names = new Set(parseRefNames(local));
        for (const name of DEFAULT_BRANCH_NAMES) {
          if (names.has(name)) return name;
        }
        return null;
      });

    const mergeBase = (cwd: string, other: string) =>
      raw(cwd, ["merge-base", "HEAD", other]).pipe(
        Effect.map((value) => value.trim()),
        Effect.flatMap((sha) =>
          sha === ""
            ? Effect.fail(new GitError({ cwd, cause: `empty merge-base with ${other}` }))
            : Effect.succeed(sha),
        ),
      );

    const resolveCompare = (
      cwd: string,
      query: { readonly mode?: GitReviewMode; readonly other?: string },
    ): Effect.Effect<ComparePlan, GitReviewFailure> =>
      Effect.gen(function* () {
        const mode = query.mode ?? "uncommitted";
        if (mode === "uncommitted") {
          return {
            mode,
            other: null,
            base: "HEAD",
            baseBranch: null,
            head: null,
            includeUntracked: true,
          };
        }

        if (mode === "committed") {
          const defaultRef = yield* resolvePreferredCompareRef(cwd);
          if (defaultRef === null) {
            return yield* new GitError({ cwd, cause: "no default branch to compare" });
          }
          const base = yield* mergeBase(cwd, defaultRef);
          return {
            mode,
            other: null,
            base,
            baseBranch: defaultRef,
            head: "HEAD",
            includeUntracked: false,
          };
        }

        const other = query.other;
        if (other === undefined || isUnsafeRef(other)) {
          return yield* new GitRefNotFound({ ref: other ?? "" });
        }
        const refs = yield* listRefs(cwd);
        if (!refs.all.includes(other)) {
          return yield* new GitRefNotFound({ ref: other });
        }
        const base = yield* mergeBase(cwd, other);
        return {
          mode,
          other,
          base,
          baseBranch: other,
          head: null,
          includeUntracked: true,
        };
      });

    const currentBranch = (cwd: string) =>
      raw(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
        Effect.map((value) => {
          const name = value.trim();
          return name === "" ? null : name;
        }),
      );

    const reviewFiles = (cwd: string, repoRoot: string, plan: ComparePlan) =>
      Effect.gen(function* () {
        const diffArgs =
          plan.head === null
            ? ["diff", "--name-status", "-z", "--find-renames", plan.base]
            : ["diff", "--name-status", "-z", "--find-renames", plan.base, plan.head];
        const nameStatus = yield* raw(cwd, diffArgs);
        const tracked = parseNameStatus(nameStatus)
          .map((file) => relocate(cwd, repoRoot, file))
          .filter((file): file is GitReviewFile => file !== null);
        const files = [...tracked];
        const seen = new Set(tracked.map((file) => file.path));
        if (plan.includeUntracked) {
          const untrackedRaw = yield* raw(cwd, [
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
          ]);
          for (const gitPath of parseNulPaths(untrackedRaw)) {
            const nextPath = toWorkspacePath(cwd, repoRoot, gitPath);
            if (nextPath === null || seen.has(nextPath)) continue;
            seen.add(nextPath);
            files.push({ path: nextPath, status: "added" });
          }
        }
        files.sort((left, right) =>
          left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
        );
        return files;
      });

    const readWorktreeText = (cwd: string, relativePath: string) =>
      workspace.readFileString(cwd, relativePath);

    const toBlobPath = (cwd: string, repoRoot: string, relativePath: string): string =>
      toPosixPath(path.relative(repoRoot, path.resolve(cwd, relativePath)));

    const readBlobText = (cwd: string, treeish: string, blobPath: string) =>
      Effect.gen(function* () {
        const sizeRaw = yield* raw(cwd, ["cat-file", "-s", `${treeish}:${blobPath}`]).pipe(
          Effect.catch(() => Effect.succeed("")),
        );
        if (sizeRaw.trim() === "") return null;
        const size = Number(sizeRaw.trim());
        if (Number.isFinite(size) && size > MAX_FILE_BYTES) {
          return yield* new WorkspaceFileTooLarge({
            path: blobPath,
            size,
            limit: MAX_FILE_BYTES,
          });
        }
        const text = yield* raw(cwd, ["cat-file", "-p", `${treeish}:${blobPath}`]);
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          return yield* new WorkspaceFileTooLarge({
            path: blobPath,
            size: bytes.byteLength,
            limit: MAX_FILE_BYTES,
          });
        }
        return yield* decodeText(bytes, blobPath);
      });

    return {
      status: (cwd) =>
        Effect.gen(function* () {
          const realRoot = yield* resolveRoot(cwd);
          const repoRoot = yield* resolveRepoRoot(realRoot);
          const result = yield* Effect.tryPromise({
            try: () => simpleGit(realRoot).status(),
            catch: gitError(realRoot),
          });
          const files: GitStatusFile[] = [];
          for (const file of result.files) {
            const nextPath = toWorkspacePath(realRoot, repoRoot, file.path);
            if (nextPath === null) continue;
            const renameFrom =
              "from" in file && typeof file.from === "string" ? file.from : undefined;
            const relocatedFrom =
              renameFrom === undefined
                ? undefined
                : toWorkspacePath(realRoot, repoRoot, renameFrom);
            files.push({
              path: nextPath,
              index: file.index,
              worktree: file.working_dir,
              ...(relocatedFrom === undefined || relocatedFrom === null
                ? {}
                : { oldPath: relocatedFrom }),
            });
          }
          return { branch: result.current ?? null, files };
        }),

      branch: (cwd) =>
        Effect.gen(function* () {
          const realRoot = yield* resolveRoot(cwd);
          const current = yield* currentBranch(realRoot);
          const defaultBranch = yield* resolvePreferredCompareRef(realRoot);
          const listed = yield* listRefs(realRoot);
          return {
            current,
            defaultBranch,
            branches: listed.all,
            remotes: listed.remotes,
          };
        }),

      review: (query) =>
        Effect.gen(function* () {
          const realRoot = yield* resolveRoot(query.cwd);
          const repoRoot = yield* resolveRepoRoot(realRoot);
          const branch = yield* currentBranch(realRoot);
          const plan = yield* resolveCompare(realRoot, query);
          const files = yield* reviewFiles(realRoot, repoRoot, plan);
          return {
            mode: plan.mode,
            other: plan.other,
            branch,
            base: plan.base,
            baseBranch: plan.baseBranch,
            files,
          };
        }),

      diff: (query) =>
        Effect.gen(function* () {
          const realRoot = yield* resolveRoot(query.cwd);
          if (path.isAbsolute(query.path) || query.path.split(/[\\/]/).includes("..")) {
            return yield* new WorkspacePathEscape({ cwd: realRoot, path: query.path });
          }
          const repoRoot = yield* resolveRepoRoot(realRoot);
          const plan = yield* resolveCompare(realRoot, query);
          const files = yield* reviewFiles(realRoot, repoRoot, plan);
          const file = files.find((entry) => entry.path === query.path);
          if (file === undefined) {
            return yield* new WorkspaceFileNotFound({ path: query.path });
          }
          const oldBlobPath = toBlobPath(realRoot, repoRoot, file.oldPath ?? file.path);
          const newBlobPath = toBlobPath(realRoot, repoRoot, file.path);
          const oldContents =
            file.status === "added" ? null : yield* readBlobText(realRoot, plan.base, oldBlobPath);
          const newContents =
            file.status === "deleted"
              ? null
              : plan.head === null
                ? yield* readWorktreeText(realRoot, file.path)
                : yield* readBlobText(realRoot, plan.head, newBlobPath);
          return {
            path: file.path,
            status: file.status,
            ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
            oldContents,
            newContents,
            binary: false,
          };
        }),
    };
  }),
);
