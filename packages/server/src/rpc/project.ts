import "@orpc/experimental-effect/extensions/effect";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { implement } from "@orpc/server";
import { projectContract } from "@vibest/contract/project";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

import { FileReadError } from "../errors";
import { ProjectService } from "../project";
import type { RpcContext } from "./context";

const orpc = implement(projectContract).$context<RpcContext>();

// Directories the folder browser never shows (beyond dotfolders).
const IGNORED_DIRS = new Set(["node_modules"]);

export const projectRouter = orpc.router({
  list: orpc.list.effect(function* () {
    const projects = yield* ProjectService;
    return yield* projects.list();
  }),
  create: orpc.create.effect(function* ({ input }) {
    const projects = yield* ProjectService;
    return yield* projects.create(input);
  }),
  listDirectories: orpc.listDirectories.effect(function* ({ input }) {
    const fs = yield* FileSystem;
    const path = resolve(input.path ?? homedir());
    // Folder-picker policy (owned here, not a shared fs service): directories
    // only, hide dotfolders and node_modules, sorted by name.
    const names = yield* fs
      .readDirectory(path)
      .pipe(Effect.mapError((cause) => new FileReadError({ path, cause })));
    const candidates = names.filter((name) => !name.startsWith(".") && !IGNORED_DIRS.has(name));
    // readDirectory yields names only, so stat each to keep just directories. A
    // failing stat (e.g. broken symlink) drops that entry rather than the list.
    const flagged = yield* Effect.forEach(
      candidates,
      (name) =>
        fs.stat(join(path, name)).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.catch(() => Effect.succeed(false)),
          Effect.map((isDirectory) => ({ name, isDirectory })),
        ),
      { concurrency: "unbounded" },
    );
    const directories = flagged
      .filter((e) => e.isDirectory)
      .map((e) => ({ name: e.name, path: join(path, e.name) }));
    directories.sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(path);
    return { path, parent: parent === path ? null : parent, directories };
  }),
});
