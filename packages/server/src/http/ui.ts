import type { IncomingMessage, ServerResponse } from "node:http";
import url from "node:url";

import { Effect, FileSystem, Path } from "effect";
import sirv from "sirv";

export type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/** `node:url` has no Effect equivalent; the URLs below are all module-relative. */
const fromModuleUrl = (relative: string) => url.fileURLToPath(new URL(relative, import.meta.url));

/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
const resolveStaticDir = (): Effect.Effect<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates = [
      "./client/", // packaged: dist/client next to dist/cli.js
      "../../../../apps/app/dist/", // monorepo, from src/node
      "../../../apps/app/dist/", // monorepo, from packages/vibest/dist
    ];
    for (const candidate of candidates) {
      const dir = path.resolve(fromModuleUrl(candidate));
      const built = yield* fs
        .exists(path.join(dir, "index.html"))
        .pipe(Effect.orElseSucceed(() => false));
      if (built) return dir;
    }
    return undefined;
  });

/**
 * The UI-serving half of the server, isolated from auth/CORS/routing: `sirv`
 * over the built bundle, and a 503 when the bundle has not been built. There is
 * no dev branch — `apps/app` runs its own `vite dev` and proxies `/api` and
 * `/ws/rpc` here, so this server serves files in every mode and never hosts a
 * bundler.
 */
export const createUIHandler = (): Effect.Effect<
  UIHandler,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const staticDir = yield* resolveStaticDir();
    if (!staticDir) {
      return (_req, res) => {
        res.statusCode = 503;
        res.end("Web UI not built. Run the @vibest/app build first.");
      };
    }

    const assets = sirv(staticDir, { single: true });
    return (req, res) => assets(req, res, () => notFound(res));
  });
