import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Data, Effect, Scope } from "effect";
import { net, protocol } from "electron";

export const SCHEME = "vibest";
export const HOST = "app";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

export class ProtocolRegistrationError extends Data.TaggedError("ProtocolRegistrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
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

export type FetchAsset = (url: string) => Promise<Response>;

/** Serve renderer assets with SPA fallback. */
export function createAppRequestHandler(rendererRoot: string, fetchAsset: FetchAsset = net.fetch) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });

    const file = resolveAssetPath(rendererRoot, url.pathname);
    if (!file) return new Response("Not found", { status: 404 });

    const target =
      fs.existsSync(file) && fs.statSync(file).isFile()
        ? file
        : path.join(rendererRoot, "index.html");

    return fetchAsset(pathToFileURL(target).toString());
  };
}

export function registerAppProtocol(
  rendererRoot: string,
): Effect.Effect<void, ProtocolRegistrationError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => protocol.handle(SCHEME, createAppRequestHandler(rendererRoot)),
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
