import { Effect, FileSystem, Layer, Option, PlatformError } from "effect";

/** The `NotFound` a real platform FileSystem reports for a missing path. */
export const notFound = (method: string, path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

/** A failure that is *not* `NotFound`, so it must not be swallowed as "absent". */
export const permissionDenied = (method: string, path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

/**
 * A `FileSystem` with only the listed methods implemented. Everything else
 * fails `NotFound`, which is what `FileSystem.makeNoop` does — so a bare
 * `fakeFileSystem({})` is a machine where nothing exists.
 */
export const fakeFileSystem = (
  overrides: Partial<FileSystem.FileSystem>,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop(overrides));

/** A `File.Info` carrying only the two fields these tests read. */
export const fileInfo = (
  type: FileSystem.File.Info["type"],
  mode: number,
): FileSystem.File.Info => ({
  type,
  mode,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
});

/**
 * A `FileSystem` whose `stat` knows exactly the listed paths; everything else
 * fails `NotFound`. `stat` is the whole surface the executable resolvers read,
 * so this stands in for a machine with a given set of CLIs installed without
 * touching a real disk.
 */
export const fakeStats = (
  entries: Readonly<Record<string, FileSystem.File.Info>>,
): Layer.Layer<FileSystem.FileSystem> =>
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      stat: (path) => {
        const info = entries[path];
        return info ? Effect.succeed(info) : Effect.fail(notFound("stat", path));
      },
    }),
  );

/** {@link fakeStats} for the common case: these paths are executable files. */
export const fakeExecutables = (
  ...paths: ReadonlyArray<string>
): Layer.Layer<FileSystem.FileSystem> =>
  fakeStats(Object.fromEntries(paths.map((path) => [path, fileInfo("File", 0o755)])));
