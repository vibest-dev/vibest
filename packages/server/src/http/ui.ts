import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import url from "node:url";

import sirv from "sirv";

export type UIHandler = (req: IncomingMessage, res: ServerResponse) => void;

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    new URL("./client/", import.meta.url), // packaged: dist/client next to dist/cli.js
    new URL("../../../../apps/app/dist/", import.meta.url), // monorepo, from src/node
    new URL("../../../apps/app/dist/", import.meta.url), // monorepo, from packages/vibest/dist
  ];
  for (const candidate of candidates) {
    const dir = path.resolve(url.fileURLToPath(candidate));
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * The UI-serving half of the server, isolated from auth/CORS/routing: Vite
 * middleware in dev (its HMR socket shares the HTTP server), `sirv` over the
 * built bundle in prod, and a 503 when the bundle has not been built.
 */
export async function createUIHandler(
  server: Server,
  isDev: boolean,
): Promise<{ readonly serveUI: UIHandler; readonly closeUI: () => Promise<void> }> {
  if (isDev) {
    // Import vite lazily so the production bundle never depends on it
    // (vite is a devDependency and marked external in tsdown.config.ts).
    const { createServer: createViteDevServer } = await import("vite");
    const vite = await createViteDevServer({
      // Serve the standalone web app package (apps/app) through this server.
      root: path.resolve(url.fileURLToPath(new URL("../../../../apps/app/", import.meta.url))),
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    });
    return {
      serveUI: (req, res) => vite.middlewares(req, res, () => notFound(res)),
      closeUI: () => vite.close(),
    };
  }

  const staticDir = resolveStaticDir();
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
}
