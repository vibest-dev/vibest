import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem } from "effect";

/** Run `f` against a scoped temp directory with the real Node FileSystem provided. */
export const withTmp = <A, E>(
  f: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* Effect.orDie(fs.makeTempDirectoryScoped());
    return yield* f(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));
