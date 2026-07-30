import os from "node:os";
import nodePath from "node:path";

import { Context, Layer } from "effect";

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

const resolve = (home: string) => ({
  home,
  projectsFile: nodePath.join(home, "storage", "projects.json"),
  configFile: nodePath.join(home, "config.json"),
  sessionsDir: nodePath.join(home, "storage", "sessions"),
});

/**
 * `$VIBEST_HOME`, falling back to `~/.vibest` — the single home every client
 * (server Paths, CLI, desktop, daemon launcher) resolves through, so the
 * one-daemon-per-home invariant can never drift on a second definition.
 *
 * Deliberately a plain function, not an Effect: an env lookup and a string join
 * perform no effectful work, so per `.agents/rules/stack.md` they stay
 * synchronous. (`node:os.homedir` has no Effect equivalent either way.) Every
 * caller today is already inside an `Effect.gen` with `Path` in scope — that is
 * not the reason this is sync, and making it an Effect would cost them nothing;
 * it is sync because there is nothing here to suspend.
 */
export function resolveVibestHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VIBEST_HOME ?? nodePath.join(os.homedir(), ".vibest");
}

/** Point the runtime at an explicit home directory (used in tests). */
export const layerPaths = (home: string): Layer.Layer<Paths> => Layer.succeed(Paths, resolve(home));

/** Default: `$VIBEST_HOME`, falling back to `~/.vibest`. */
export const PathsLayer: Layer.Layer<Paths> = Layer.sync(
  Paths,
  // Resolved when the layer is built, not when this module is imported — the
  // daemon sets `VIBEST_HOME` in the child's environment.
  () => resolve(resolveVibestHome()),
);
