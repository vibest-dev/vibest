import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { bearerToken, type TicketStore, tokensMatch } from "./auth";
import { corsHeaders, isLoopbackHost } from "./cors";
import type { UIApp } from "./ui";

export type RequestAppOptions = {
  /**
   * When set, every `/api/*` request except `/api/health` must present
   * `Authorization: Bearer <token>`. Unset (browser mode) disables the check.
   */
  readonly authToken: string | undefined;
  /** Extra cross-origin allowlist entries on top of the built-in trusted set. */
  readonly corsOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly tickets: TicketStore;
  /** Everything the API routes below do not claim. */
  readonly ui: UIApp;
};

const forbidden = HttpServerResponse.text("Forbidden", { status: 403 });
const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });
const notFound = HttpServerResponse.text("Not Found", { status: 404 });

/**
 * The request half of the server. The WebSocket upgrade half stays on raw
 * `node:http` (see `server.ts`) because oRPC owns that event.
 *
 * Deliberately a plain sequence rather than an `HttpRouter`: the order here
 * *is* the security policy — rebinding check, then CORS, then auth, then
 * routes — and a router's middleware layering would obscure it. There are no
 * path parameters anywhere, so nothing else is on offer.
 */
export const makeRequestApp = (
  options: RequestAppOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  route(options).pipe(
    /**
     * Refusals only — no access log. A 2xx here is the UI loading its own
     * bundle or the supervisor polling health, which says nothing that the RPC
     * and session lines do not say better. A 4xx is the interesting half: a
     * rebound Host, a bad token, a call to an endpoint that does not exist.
     *
     * One `tap` rather than a line at each `return` above, because the whole
     * point of that function is that the order of its checks is readable as the
     * security policy, and eight logging calls interleaved would end that.
     */
    Effect.tap((response) =>
      response.status < 400
        ? Effect.void
        : HttpServerRequest.HttpServerRequest.pipe(
            Effect.flatMap((request) => {
              const path = new URL(request.url, "http://localhost").pathname;
              const annotations = {
                event: "http.refused",
                status: response.status,
                method: request.method,
                path,
                ...(request.headers.origin !== undefined ? { origin: request.headers.origin } : {}),
                ...(request.headers.host !== undefined ? { host: request.headers.host } : {}),
              };
              // A 404 off the API surface is the browser asking for something
              // it always asks for — `favicon.ico`, a source map — and warning
              // about it twice per page load is how a log stops being read.
              // Under `/api/` the same status means a client called a procedure
              // that does not exist, which is a real mismatch; and 401/403 are
              // security answers at any path.
              const routine = response.status === 404 && !path.startsWith("/api/");
              return routine
                ? Effect.logDebug("http request not found").pipe(Effect.annotateLogs(annotations))
                : Effect.logWarning("http request refused").pipe(Effect.annotateLogs(annotations));
            }),
          ),
    ),
  );

const route = (
  options: RequestAppOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    // Anti DNS-rebinding: the server binds loopback, so a request whose Host
    // is not loopback comes from an attacker page whose domain rebound to
    // 127.0.0.1 — CORS would not stop it, this does. Answered before the CORS
    // headers are computed, so a rebound request gets none of them.
    if (!isLoopbackHost(request.headers.host, options.allowedHosts)) {
      return forbidden;
    }

    const headers = corsHeaders(request.headers.origin, {
      extraOrigins: options.corsOrigins,
      allowedHosts: options.allowedHosts,
    });
    const withCors = (response: HttpServerResponse.HttpServerResponse) =>
      headers ? HttpServerResponse.setHeaders(response, headers) : response;

    if (request.method === "OPTIONS") {
      // A preflight from an origin we don't allow gets no headers, so the
      // browser blocks the real request that would have followed.
      return withCors(HttpServerResponse.empty({ status: headers ? 204 : 403 }));
    }

    const pathname = new URL(request.url, "http://localhost").pathname;

    // Unauthenticated on purpose: the desktop supervisor polls this before
    // it holds a token, and it discloses nothing.
    if (request.method === "GET" && pathname === "/api/health") {
      return withCors(HttpServerResponse.text("ok"));
    }

    if (options.authToken !== undefined && pathname.startsWith("/api/")) {
      if (!tokensMatch(options.authToken, bearerToken(request.headers.authorization))) {
        return withCors(unauthorized);
      }
    }

    if (request.method === "POST" && pathname === "/api/ws-ticket") {
      return withCors(HttpServerResponse.jsonUnsafe({ ticket: options.tickets.issue() }));
    }

    if (pathname.startsWith("/api/")) {
      return withCors(notFound);
    }

    // The dev branch of the UI app writes its own bytes to the raw response, so
    // a header added to the value it returns would never reach the socket. Set
    // them on the socket as well; node merges `setHeader` into `writeHead`, so
    // the static branch below still ends up with exactly one of each.
    if (headers) {
      const nodeResponse = NodeHttpServerRequest.toServerResponse(request);
      for (const [name, value] of Object.entries(headers)) {
        nodeResponse.setHeader(name, value);
      }
    }
    return withCors(yield* options.ui);
  });
