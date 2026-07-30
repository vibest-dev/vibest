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
    // Map the service's typed effect errors onto the contract's declared errors,
    // so the client gets a code + data instead of a generic 500.
    return yield* fs.readFileString(input.cwd, input.path).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (e) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: e.cwd, path: e.path } })),
        WorkspaceNotFile: (e) => Effect.fail(errors.NOT_FILE({ data: { path: e.path } })),
        WorkspaceFileTooLarge: (e) =>
          Effect.fail(
            errors.FILE_TOO_LARGE({ data: { path: e.path, size: e.size, limit: e.limit } }),
          ),
        WorkspaceBinaryFile: (e) => Effect.fail(errors.BINARY_FILE({ data: { path: e.path } })),
        WorkspaceReadError: (e) => Effect.fail(errors.READ_FAILED({ data: { path: e.path } })),
      }),
    );
  }),
  browse: orpc.browse.effect(function* ({ input, errors }) {
    const fs = yield* FileSystem;
    // Resolving and joining are pure string math, so they stay on `node:path`.
    const dir = path.resolve(input.path ?? os.homedir());
    // Folder-picker policy (owned here, not a shared fs service): directories
    // only, hide dotfolders and node_modules, sorted by name.
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError(() => errors.READ_FAILED({ data: { path: dir } })));
    const candidates = names.filter((name) => !name.startsWith(".") && !IGNORED_DIRS.has(name));
    // readDirectory yields names only, so stat each to keep just directories. A
    // failing stat (e.g. broken symlink) drops that entry rather than the list.
    const flagged = yield* Effect.forEach(
      candidates,
      (name) =>
        fs.stat(path.join(dir, name)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((isDirectory) => ({ name, isDirectory })),
        ),
      { concurrency: "unbounded" },
    );
    const directories = flagged
      .filter((e) => e.isDirectory)
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
    directories.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, directories };
  }),
});

export type FsRouter = typeof fsRouter;
