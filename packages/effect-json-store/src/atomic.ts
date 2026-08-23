import path from "node:path";

import { Effect, type FileSystem, type PlatformError } from "effect";

/**
 * Write `text` to `file` atomically: write a randomly named sibling temp file,
 * then rename it over the target, so a concurrent reader never sees a
 * half-written file and a failed write leaves the original bytes untouched.
 *
 * The temp file is an acquired resource: whether the write succeeds, fails, is
 * interrupted, or dies, the release step removes whatever is still at the temp
 * path. After a successful rename the path is already gone, so removal runs
 * with `force` and a missing file counts as completed cleanup; any other
 * cleanup failure is logged and swallowed so it never masks the write's own
 * outcome.
 */
export const writeFileAtomic = (
  fs: FileSystem.FileSystem,
  file: string,
  text: string,
  options?: { readonly mode?: number },
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => `${file}.${crypto.randomUUID()}.tmp`),
    (tmp) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(tmp, text, options);
        if (options?.mode !== undefined) {
          // `mode` on the write is masked by the process umask; chmod pins the
          // exact permissions.
          yield* fs.chmod(tmp, options.mode);
        }
        yield* fs.rename(tmp, file);
      }),
    (tmp) =>
      fs
        .remove(tmp, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`failed to remove temp file ${tmp}`, cause),
          ),
        ),
  );
