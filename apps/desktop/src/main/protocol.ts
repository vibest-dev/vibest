import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { DESKTOP_RPC_PREFIX } from "../shared/desktop-rpc";

export const SCHEME = "vibest";
export const HOST = "app";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

export type DesktopRpcHandler = (
  request: Request,
) => Promise<{ matched: true; response: Response } | { matched: false }>;

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Map a request path to a file inside the renderer bundle. */
export function resolveAssetPath(rendererRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const file = path.resolve(rendererRoot, `.${decoded}`);
  const relative = path.relative(rendererRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

function isDesktopRpcPath(pathname: string): boolean {
  return pathname === DESKTOP_RPC_PREFIX || pathname.startsWith(`${DESKTOP_RPC_PREFIX}/`);
}

/** Serve Desktop RPC first, then renderer assets with SPA fallback. */
export function createAppRequestHandler(rendererRoot: string, rpc: DesktopRpcHandler) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });

    if (isDesktopRpcPath(url.pathname)) {
      const result = await rpc(request);
      return result.matched ? result.response : new Response("Not found", { status: 404 });
    }

    const file = resolveAssetPath(rendererRoot, url.pathname);
    if (!file) return new Response("Not found", { status: 404 });

    const target =
      fs.existsSync(file) && fs.statSync(file).isFile()
        ? file
        : path.join(rendererRoot, "index.html");

    return net.fetch(pathToFileURL(target).toString());
  };
}

export function registerAppProtocol(rendererRoot: string, rpc: DesktopRpcHandler): void {
  protocol.handle(SCHEME, createAppRequestHandler(rendererRoot, rpc));
}

export function unregisterAppProtocol(): void {
  protocol.unhandle(SCHEME);
}
