import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
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

export type UIHandler = {
  readonly ui: UIApp;
  readonly closeUI: () => Promise<void>;
};

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

type ConnectMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * Hand the request to a connect-style middleware, which writes to the raw node
 * response itself. `NodeHttpServer`'s `handleResponse` skips a response whose
 * socket is already ended, so the value resolved here is a placeholder for the
 * "middleware handled it" case and a real 404 for the "it passed" case.
 */
const runMiddleware = (middleware: ConnectMiddleware): UIApp =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const nodeRequest = NodeHttpServerRequest.toIncomingMessage(request);
    const nodeResponse = NodeHttpServerRequest.toServerResponse(request);
    return yield* Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
      let settled = false;
      const done = (response: HttpServerResponse.HttpServerResponse) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(response));
      };
      nodeResponse.once("finish", () => done(HttpServerResponse.empty()));
      middleware(nodeRequest, nodeResponse, () => done(notFound));
    });
  });

/**
 * The UI-serving half of the server, isolated from auth/CORS/routing: Vite
 * middleware in dev (its HMR socket shares the HTTP server), `HttpStaticServer`
 * over the built bundle in prod, and a 503 when the bundle has not been built.
 */
export const createUIHandler = (
  server: Server,
  isDev: boolean,
): Effect.Effect<UIHandler, never, FileSystem.FileSystem | Path.Path | HttpPlatform.HttpPlatform> =>
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
        ui: runMiddleware(vite.middlewares as ConnectMiddleware),
        closeUI: () => vite.close(),
      };
    }

    const staticDir = yield* resolveStaticDir();
    if (!staticDir) {
      return {
        ui: Effect.succeed(
          HttpServerResponse.text("Web UI not built. Run the @vibest/app build first.", {
            status: 503,
          }),
        ),
        closeUI: async () => {},
      };
    }

    // `spa: true` is the old `sirv(dir, { single: true })`: an unknown path
    // falls back to index.html so the client router owns deep links.
    const assets = yield* HttpStaticServer.make({ root: staticDir, spa: true }).pipe(Effect.orDie);
    return {
      // A path that matches no file is a 404; anything else went wrong on our
      // side. `RouteNotFound` covers both a missing asset and a deep link the
      // SPA fallback declined (it only rewrites extensionless paths from a
      // client that accepts HTML — a browser navigation, never a fetch).
      ui: assets.pipe(
        Effect.catch((error) =>
          error.reason._tag === "RouteNotFound"
            ? Effect.succeed(notFound)
            : Effect.as(
                Effect.logError("static asset read failed", error),
                HttpServerResponse.text("Internal Server Error", { status: 500 }),
              ),
        ),
      ),
      closeUI: async () => {},
    };
  });
