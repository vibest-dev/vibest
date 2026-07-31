import os from "node:os";
import path from "node:path";

import { Context, Layer } from "effect";

/**
 * Resolved filesystem locations the runtime persists to. Injected as a service
 * so tests can point it at a temp dir instead of `~/.vibest`.
 *
 * `projects.json` lives under `storage/` (a data collection).
 */
export class Paths extends Context.Service<
  Paths,
  {
    readonly home: string;
    readonly projectsFile: string;
    /** `storage/sessions/` — one `<projectId>/` subdir per project. */
    readonly sessionsDir: string;
  }
>()("Paths") {}

const resolve = (home: string) => ({
  home,
  projectsFile: path.join(home, "storage", "projects.json"),
  sessionsDir: path.join(home, "storage", "sessions"),
});

/**
 * `$VIBEST_HOME`, falling back to `~/.vibest` — the single home every client
 * (server Paths, CLI, desktop, daemon launcher) resolves through, so the
 * one-daemon-per-home invariant can never drift on a second definition.
 *
 * A plain function, not an Effect: an env lookup and a string join perform no
 * effectful work (`.agents/rules/stack.md`, "Where the boundary is"). Not
 * because callers lack a runtime — every one of them is inside an `Effect.gen`
 * today — but because there is nothing here to suspend.
 */
export function resolveVibestHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VIBEST_HOME ?? path.join(os.homedir(), ".vibest");
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
