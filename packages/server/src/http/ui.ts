import { fileURLToPath } from "node:url";

import { Effect, FileSystem, Path } from "effect";
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
 * The UI-serving half of the server: the built bundle, or a 503 saying it has
 * not been built. There is no dev branch — `apps/app` runs its own `vite dev`
 * and proxies `/api` and `/ws/rpc` here, so this server serves files in every
 * mode and never hosts a bundler.
 */
export const createUIApp = (): Effect.Effect<
  UIApp,
  never,
  FileSystem.FileSystem | Path.Path | HttpPlatform.HttpPlatform
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
    const assets = yield* HttpStaticServer.make({ root: staticDir, spa: true }).pipe(Effect.orDie);

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
