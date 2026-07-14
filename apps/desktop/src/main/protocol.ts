import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

export const SCHEME = "vibest";
export const HOST = "app";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

/**
 * Must run before app.whenReady(): Electron only accepts privileged-scheme
 * registration during startup. `standard` gives the scheme a real origin (so
 * the renderer isn't opaque), `secure` lets it use APIs gated on secure
 * contexts, and `supportFetchAPI` lets the app fetch its own assets.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Map a request path to a file inside the renderer bundle, or null if it tries
 * to escape it.
 */
export function resolveAssetPath(rendererRoot: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const file = path.resolve(rendererRoot, `.${decoded}`);
  const relative = path.relative(rendererRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

/**
 * Serve the renderer bundle off disk. This protocol is *only* an asset server —
 * it never proxies the backend, which the renderer calls directly on loopback.
 */
export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response("Not found", { status: 404 });
    }

    const file = resolveAssetPath(rendererRoot, url.pathname);
    if (!file) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback. The router owns every path that isn't a real file
    // (/chat/abc123, and every deep link the user reloads on), so those must
    // serve the shell, not 404.
    const target =
      fs.existsSync(file) && fs.statSync(file).isFile()
        ? file
        : path.join(rendererRoot, "index.html");

    return net.fetch(pathToFileURL(target).toString());
  });
}
