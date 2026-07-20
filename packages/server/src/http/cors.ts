/**
 * Origin / host policy for the local daemon. Static by design: the desktop
 * renderer's fixed scheme and any loopback web client are always trusted, so a
 * CLI-started daemon accepts the desktop with no per-launch origin negotiation
 * (and no restart-to-widen-CORS dance). Extra origins — e.g. a future hosted
 * web app reaching into a local daemon — come from `VIBEST_CORS_ORIGINS`.
 */

/** The desktop renderer's custom-scheme origin (see desktop app-protocol.ts). */
const DESKTOP_ORIGIN = "vibest://app";

/** `http(s)://localhost | 127.0.0.1 | [::1]` on any port — the loopback web clients. */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

/**
 * Whether a browser Origin may talk to the daemon — used for both the CORS
 * response headers and the WebSocket-upgrade guard. A same-origin browser
 * request and a native client both send no Origin, which callers handle before
 * reaching here.
 */
export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
  return origin === DESKTOP_ORIGIN || LOOPBACK_ORIGIN.test(origin) || extra.includes(origin);
}

/**
 * Whether a Host header names the loopback interface the daemon binds. The
 * server listens on `127.0.0.1` only, so a request arriving with any other Host
 * is a DNS-rebinding attempt (an attacker page whose domain now resolves to
 * loopback, which CORS does not stop) and must be refused. A request with no
 * Host is not a browser and is left to the auth layer.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * CORS headers for an allowlisted cross-origin request, or null to deny. A
 * same-origin browser request sends no Origin header and never reaches here.
 * The origin is echoed (never `*`) so credentials can be sent.
 */
export function corsHeaders(
  origin: string | undefined,
  extra: readonly string[] = [],
): Record<string, string> | null {
  if (!origin || !isAllowedOrigin(origin, extra)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
