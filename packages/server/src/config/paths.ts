import { homedir } from "node:os";
import nodePath from "node:path";

import { Context, Effect, Layer, Path } from "effect";

/**
 * Resolved filesystem locations the runtime persists to. Injected as a service
 * so tests can point it at a temp dir instead of `~/.vibest`.
 *
 * - `projects.json` lives under `storage/` (a data collection)
 * - `config.json` lives directly under the home root (single config file)
 */
export class Paths extends Context.Service<
  Paths,
  {
    readonly home: string;
    readonly projectsFile: string;
    readonly configFile: string;
    /** `storage/sessions/` — one `<projectId>/` subdir per project. */
    readonly sessionsDir: string;
  }
>()("Paths") {}

const resolve = (path: Path.Path, home: string) => ({
  home,
  projectsFile: path.join(home, "storage", "projects.json"),
  configFile: path.join(home, "config.json"),
  sessionsDir: path.join(home, "storage", "sessions"),
});

/**
 * `$VIBEST_HOME`, falling back to `~/.vibest` — the single home every client
 * (server Paths, CLI, desktop, daemon launcher) resolves through, so the
 * one-daemon-per-home invariant can never drift on a second definition.
 *
 * Deliberately a plain function: it is the one thing every front door needs
 * before it has a runtime, and `node:os.homedir` has no Effect equivalent
 * anyway, so the join rides along with it.
 */
export function resolveVibestHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VIBEST_HOME ?? nodePath.join(homedir(), ".vibest");
}

/** Point the runtime at an explicit home directory (used in tests). */
export const layerPaths = (home: string): Layer.Layer<Paths, never, Path.Path> =>
  Layer.effect(
    Paths,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return resolve(path, home);
    }),
  );

/** Default: `$VIBEST_HOME`, falling back to `~/.vibest`. */
export const PathsLayer: Layer.Layer<Paths, never, Path.Path> = Layer.effect(
  Paths,
  // Resolved when the layer is built, not when this module is imported — the
  // daemon sets `VIBEST_HOME` in the child's environment.
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return resolve(path, resolveVibestHome());
  }),
);
