import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
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
 * The UI-serving half of the server, isolated from auth/CORS/routing: `sirv`
 * over the built bundle, and a 503 when the bundle has not been built. There is
 * no dev branch — `apps/app` runs its own `vite dev` and proxies `/api` and
 * `/ws/rpc` here, so this server serves files in every mode and never hosts a
 * bundler.
 */
export function createUIHandler(): UIHandler {
  const staticDir = resolveStaticDir();
  if (!staticDir) {
    return (_req, res) => {
      res.statusCode = 503;
      res.end("Web UI not built. Run the @vibest/app build first.");
    };
  }

  const assets = sirv(staticDir, { single: true });
  return (req, res) => assets(req, res, () => notFound(res));
}
