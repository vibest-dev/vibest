import { Context, Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

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
  }
>()("Paths") {}

const resolve = (home: string) => ({
  home,
  projectsFile: join(home, "storage", "projects.json"),
  configFile: join(home, "config.json"),
});

/** Point the runtime at an explicit home directory (used in tests). */
export const layerPaths = (home: string): Layer.Layer<Paths> =>
  Layer.sync(Paths, () => resolve(home));

/** Default: `$VIBEST_HOME`, falling back to `~/.vibest`. */
export const PathsLayer: Layer.Layer<Paths> = Layer.sync(Paths, () =>
  resolve(process.env.VIBEST_HOME ?? join(homedir(), ".vibest")),
);
