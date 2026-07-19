import { homedir } from "node:os";
import { join } from "node:path";

import { Context, Layer } from "effect";

/**
 * Resolved persistence locations, injected as a service so tests can point it
 * at a temp dir instead of `~/.vibest`. It owns every path the runtime touches
 * so no consumer hand-builds one:
 *
 * - `projectsStore` — the projects collection file under `storage/`
 * - `configStore` — the single config file at the home root
 * - `sessionStoreDir(projectId)` — the directory holding a project's session
 *   records; `sessionStoreFile(projectId, sessionId)` — a single record's file
 */
export class Paths extends Context.Service<
  Paths,
  {
    readonly home: string;
    readonly projectsStore: string;
    readonly configStore: string;
    readonly sessionStoreDir: (projectId: string) => string;
    readonly sessionStoreFile: (projectId: string, sessionId: string) => string;
  }
>()("Paths") {}

const resolve = (home: string) => {
  const sessionsRoot = join(home, "storage", "sessions");
  return {
    home,
    projectsStore: join(home, "storage", "projects.json"),
    configStore: join(home, "config.json"),
    sessionStoreDir: (projectId: string) => join(sessionsRoot, projectId),
    sessionStoreFile: (projectId: string, sessionId: string) =>
      join(sessionsRoot, projectId, `${sessionId}.json`),
  };
};

/** Point the runtime at an explicit home directory (used in tests). */
export const layerPaths = (home: string): Layer.Layer<Paths> =>
  Layer.sync(Paths, () => resolve(home));

/** Default: `$VIBEST_HOME`, falling back to `~/.vibest`. */
export const PathsLayer: Layer.Layer<Paths> = Layer.sync(Paths, () =>
  resolve(process.env.VIBEST_HOME ?? join(homedir(), ".vibest")),
);
