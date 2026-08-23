import "@orpc/experimental-effect/extensions/effect";
import os from "node:os";
import path from "node:path";

import { implement } from "@orpc/server";
import { fsContract } from "@vibest/contract/fs";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

import { FileSystemService } from "../fs";
import type { RpcContext } from "./context";

const orpc = implement(fsContract).$context<RpcContext>();

// Directories the folder browser never shows (beyond dotfolders).
const IGNORED_DIRS = new Set(["node_modules"]);

export const fsRouter = orpc.router({
  readFileString: orpc.readFileString.effect(function* ({ input, errors }) {
    const fs = yield* FileSystemService;
    return yield* fs.readFileString(input.cwd, input.path).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceFileNotFound: (error) =>
          Effect.fail(errors.NOT_FOUND({ data: { path: error.path } })),
        WorkspaceNotFile: (error) => Effect.fail(errors.NOT_FILE({ data: { path: error.path } })),
        WorkspaceFileTooLarge: (error) =>
          Effect.fail(
            errors.FILE_TOO_LARGE({
              data: { path: error.path, size: error.size, limit: error.limit },
            }),
          ),
        WorkspaceBinaryFile: (error) =>
          Effect.fail(errors.BINARY_FILE({ data: { path: error.path } })),
        WorkspaceReadError: (error) =>
          Effect.fail(errors.READ_FAILED({ data: { path: error.path } })),
      }),
    );
  }),
  readTree: orpc.readTree.effect(function* ({ input, errors }) {
    const fs = yield* FileSystemService;
    return yield* fs.readTree(input.cwd).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceNotDirectory: (error) =>
          Effect.fail(errors.NOT_DIRECTORY({ data: { path: error.path } })),
        WorkspaceReadError: (error) =>
          Effect.fail(errors.READ_FAILED({ data: { path: error.path } })),
      }),
    );
  }),
  browse: orpc.browse.effect(function* ({ input, errors }) {
    const fs = yield* FileSystem;
    const dir = path.resolve(input.path ?? os.homedir());
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError(() => errors.READ_FAILED({ data: { path: dir } })));
    const candidates = names.filter(
      (name) => (input.includeHidden || !name.startsWith(".")) && !IGNORED_DIRS.has(name),
    );
    const flagged = yield* Effect.forEach(
      candidates,
      (name) =>
        fs.stat(path.join(dir, name)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((isDirectory) => ({ name, isDirectory })),
        ),
      { concurrency: 32 },
    );
    const directories = flagged
      .filter((entry) => entry.isDirectory)
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
    directories.sort((left, right) => left.name.localeCompare(right.name));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, directories };
  }),
});

export type FsRouter = typeof fsRouter;
