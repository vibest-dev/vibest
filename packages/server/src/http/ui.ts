import path from "node:path";
import url from "node:url";

import { Effect, FileSystem, type Path } from "effect";
import type { HttpPlatform } from "effect/unstable/http";
import { HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";

/**
 * Answers everything the API routes did not claim. `never` on the error channel
 * because a UI miss is a response (404 / 503), not a failure.
 */
export type UIApp = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
>;

const notFound = HttpServerResponse.text("Not Found", { status: 404 });

/** `node:url` has no Effect equivalent; the URLs below are all module-relative. */
const fromModuleUrl = (relative: string) => url.fileURLToPath(new URL(relative, import.meta.url));

/**
 * Locate the built web UI: the packaged layout ships it next to the server
 * bundle as `client/`, while running from monorepo source falls back to
 * `apps/app/dist`.
 */
const resolveStaticDir = (): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
 * The UI-serving half of the server, isolated from auth/CORS/routing:
 * `HttpStaticServer` over the built bundle, and a 503 when the bundle has not
 * been built. There is no dev branch — `apps/app` runs its own `vite dev` and
 * proxies `/api` and `/ws/rpc` here, so this server serves files in every mode
 * and never hosts a bundler.
 */
export const createUIHandler = (): Effect.Effect<
  UIApp,
  never,
  // `Path` is not ours: `HttpStaticServer.make` asks for it. Our own path math
  // below is pure and stays on `node:path`.
  FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path
> =>
  Effect.gen(function* () {
    const staticDir = yield* resolveStaticDir();
    if (!staticDir) {
      return Effect.succeed(
        HttpServerResponse.text("Web UI not built. Run the @vibest/app build first.", {
          status: 503,
        }),
      );
    }

    // `spa: true` is the old `sirv(dir, { single: true })`: an unknown path
    // falls back to index.html so the client router owns deep links.
    // No `cacheControl` here, despite the hashed asset names: the option is
    // global, and `HttpStaticServer` reuses `serveFile` for the SPA fallback
    // (`HttpStaticServer.js:104`), so `immutable` would pin `index.html` too
    // and strand clients on a stale app. Per-asset headers need a wrapper.
    const assets = yield* HttpStaticServer.make({ root: staticDir, spa: true }).pipe(
      // `resolveStaticDir` just proved `index.html` exists here, so a platform
      // failure opening the same directory is a defect, not a served error.
      Effect.catchTag("PlatformError", (cause) =>
        Effect.die(
          new Error(`invariant: static server could not open verified UI bundle at ${staticDir}`, {
            cause,
          }),
        ),
      ),
    );

    // A path that matches no file is a 404; anything else went wrong on our
    // side. `RouteNotFound` covers both a missing asset and a deep link the
    // SPA fallback declined (it only rewrites extensionless paths from a
    // client that accepts HTML — a browser navigation, never a fetch).
    return assets.pipe(
      Effect.catch((error) =>
        error.reason._tag === "RouteNotFound"
          ? Effect.succeed(notFound)
          : Effect.as(
              Effect.logError("static asset read failed", error),
              HttpServerResponse.text("Internal Server Error", { status: 500 }),
            ),
      ),
    );
  });
