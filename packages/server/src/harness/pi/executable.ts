import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { Effect, type FileSystem } from "effect";

import { ExecutableNotFound } from "../errors";
import {
  candidateNames,
  executableAt,
  searchInstallDirs,
  type ResolveExecutableDeps,
} from "../executable";

const moduleRequire = module.createRequire(import.meta.url);

/** The npm package `packages/server` depends on to ship a working pi. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const NOT_FOUND =
  "Pi was not found. Install it from https://github.com/earendil-works/pi, " +
  "or set VIBEST_PI_EXECUTABLE to the path of the `pi` binary.";

/**
 * The pi that ships with vibest. Unlike codex, pi is one of our own
 * dependencies (`packages/server/package.json`), so a working copy is on disk
 * next to the server whether or not the user ever installed pi themselves —
 * and until now nothing looked there, so a machine carrying a perfectly good
 * `node_modules/.bin/pi` was told pi was not installed.
 *
 * Found as the `node_modules/.bin` shim rather than through the module graph,
 * for two reasons. `require.resolve` cannot see into this package at all — its
 * `exports` map declares only `.` and `./rpc-entry`, both `import`-conditioned,
 * so a CJS resolve of the entry *or* of `package.json` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. And the manifest's `bin` points at a plain
 * `dist/cli.js`, which carries no guarantee of an execute bit; the shim the
 * package manager writes is the artifact that is guaranteed runnable, on
 * Windows too. `resolve.paths` gives the `node_modules` chain without consulting
 * `exports`, which is the one thing here that stays a module-graph question.
 *
 * Only nominates — the caller verifies. It resolves from both entry points that
 * matter, and that is not free: `packages/vibest` declares pi as a dependency of
 * its own so the bundled CLI's module graph reaches it, exactly as it already
 * does for the Claude SDK. Drop that declaration and this level goes quiet in
 * the shipped CLI while still passing every test from a source checkout. The
 * version there is pinned literally and must move with `packages/server`'s.
 */
function bundledPi(binary: string): string | undefined {
  for (const nodeModules of moduleRequire.resolve.paths(PI_PACKAGE) ?? []) {
    if (fs.existsSync(path.join(nodeModules, ...PI_PACKAGE.split("/")))) {
      return path.join(nodeModules, ".bin", binary);
    }
  }
  return undefined;
}

export type ResolvePiDeps = ResolveExecutableDeps & {
  /** The copy shipped inside our own `node_modules`. Injectable for tests. */
  bundled?: (binary: string) => string | undefined;
};

/**
 * The `pi` binary to spawn: an explicit override (unverified — naming a path is
 * the user saying "this one"), else our own bundled copy, else the machine's.
 * Ours is preferred over the user's install because its version is the one this
 * server's RPC vocabulary was written against.
 */
export const resolvePiExecutable = (
  deps: ResolvePiDeps = {},
): Effect.Effect<string, ExecutableNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const override = (deps.env ?? process.env)["VIBEST_PI_EXECUTABLE"];
    if (override) return override;

    for (const name of candidateNames("pi", deps.platform ?? process.platform)) {
      const bundled = (deps.bundled ?? bundledPi)(name);
      if (!bundled) continue;
      const verified = yield* executableAt(bundled, deps);
      if (verified) return verified;
    }

    const installed = yield* searchInstallDirs("pi", deps);
    if (installed) return installed;

    return yield* Effect.fail(
      new ExecutableNotFound({
        harnessAgentId: "pi",
        executable: "pi",
        reason: NOT_FOUND,
      }),
    );
  });
