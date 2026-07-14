import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Data, Effect, Scope } from "effect";
import { net, protocol } from "electron";

import { DESKTOP_RPC_PREFIX } from "../../shared/desktop-rpc";

export const SCHEME = "vibest";
export const HOST = "app";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

export class ProtocolRegistrationError extends Data.TaggedError("ProtocolRegistrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AppRequestHandler = (request: Request) => Promise<Response | undefined>;

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
export function createAppRequestHandler(rendererRoot: string, requestHandler: AppRequestHandler) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });

    if (isDesktopRpcPath(url.pathname)) {
      return (await requestHandler(request)) ?? new Response("Not found", { status: 404 });
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

export function registerAppProtocol(
  rendererRoot: string,
  requestHandler: AppRequestHandler,
): Effect.Effect<void, ProtocolRegistrationError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => protocol.handle(SCHEME, createAppRequestHandler(rendererRoot, requestHandler)),
      catch: (cause) =>
        new ProtocolRegistrationError({
          message: "Unable to register the vibest protocol",
          cause,
        }),
    }),
    () =>
      Effect.sync(() => {
        try {
          protocol.unhandle(SCHEME);
        } catch {
          // Electron may already have torn protocol handling down during exit.
        }
      }),
  ).pipe(Effect.asVoid);
}
