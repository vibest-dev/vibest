import "@orpc/experimental-effect/extensions/effect";
import os from "node:os";
import path from "node:path";

import { implement } from "@orpc/server";
import { fsContract } from "@vibest/contract/fs";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

import { FileSystemService } from "../fs";
import type { RpcContext } from "./context";
import { translateErrors } from "./error-translation";

const orpc = implement(fsContract).$context<RpcContext>();

// Directories the folder browser never shows (beyond dotfolders).
const IGNORED_DIRS = new Set(["node_modules"]);

export const fsRouter = orpc.router({
  readFileString: orpc.readFileString.effect(function* ({ input, errors }) {
    const fs = yield* FileSystemService;
    // Map the service's typed effect errors onto the contract's declared errors,
    // so the client gets a code + data instead of a generic 500.
    return yield* translateErrors(fs.readFileString(input.cwd, input.path), {
      WorkspacePathEscape: (e) =>
        Effect.fail(errors.PATH_ESCAPE({ data: { cwd: e.cwd, path: e.path } })),
      WorkspaceFileNotFound: (e) => Effect.fail(errors.NOT_FOUND({ data: { path: e.path } })),
      WorkspaceNotFile: (e) => Effect.fail(errors.NOT_FILE({ data: { path: e.path } })),
      WorkspaceFileTooLarge: (e) =>
        Effect.fail(
          errors.FILE_TOO_LARGE({ data: { path: e.path, size: e.size, limit: e.limit } }),
        ),
      WorkspaceBinaryFile: (e) => Effect.fail(errors.BINARY_FILE({ data: { path: e.path } })),
      WorkspaceReadError: (e) => Effect.fail(errors.READ_FAILED({ data: { path: e.path } })),
    });
  }),
  readTree: orpc.readTree.effect(function* ({ input, errors }) {
    const fs = yield* FileSystemService;
    return yield* translateErrors(fs.readTree(input.cwd), {
      WorkspacePathEscape: (e) =>
        Effect.fail(errors.PATH_ESCAPE({ data: { cwd: e.cwd, path: e.path } })),
      WorkspaceNotDirectory: (e) => Effect.fail(errors.NOT_DIRECTORY({ data: { path: e.path } })),
      WorkspaceReadError: (e) => Effect.fail(errors.READ_FAILED({ data: { path: e.path } })),
    });
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
