import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { Effect, FileSystem, Path } from "effect";
import sirv from "sirv";

export type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/** `node:url` has no Effect equivalent; the URLs below are all module-relative. */
const fromModuleUrl = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

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
 * The UI-serving half of the server, isolated from auth/CORS/routing: Vite
 * middleware in dev (its HMR socket shares the HTTP server), `sirv` over the
 * built bundle in prod, and a 503 when the bundle has not been built.
 */
export const createUIHandler = (
  server: Server,
  isDev: boolean,
): Effect.Effect<
  { readonly serveUI: UIHandler; readonly closeUI: () => Promise<void> },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (isDev) {
      // Import vite lazily so the production bundle never depends on it
      // (vite is a devDependency and marked external in tsdown.config.ts).
      const vite = yield* Effect.promise(async () => {
        const { createServer: createViteDevServer } = await import("vite");
        return createViteDevServer({
          // Serve the standalone web app package (apps/app) through this server.
          root: fromModuleUrl("../../../../apps/app/"),
          server: {
            middlewareMode: true,
            hmr: { server },
          },
        });
      });
      return {
        serveUI: (req, res) => vite.middlewares(req, res, () => notFound(res)),
        closeUI: () => vite.close(),
      };
    }

    const staticDir = yield* resolveStaticDir();
    if (!staticDir) {
      return {
        serveUI: (_req, res) => {
          res.statusCode = 503;
          res.end("Web UI not built. Run the @vibest/app build first.");
        },
        closeUI: async () => {},
      };
    }

    const assets = sirv(staticDir, { single: true });
    return {
      serveUI: (req, res) => assets(req, res, () => notFound(res)),
      closeUI: async () => {},
    };
  });
